import {
  scoped,
  type Effect,
  type EffectCallArgs,
  type EventCallable,
  type EventPayload,
  type Reactive,
  type ReactiveWritable,
  type Scope,
  type Store,
  type StoreWritable,
} from "@virentia/core";
import { customRef, getCurrentScope as getCurrentVueScope, onScopeDispose, type Ref } from "vue";
import { useProvidedScope } from "./scope";
import type { AnyStore, Bound, ShapeSource, UnitLike, UnitShape } from "./types";
import { getShape, isStoreUnit, isUnitLike, readStore } from "./utils";

export function useUnit<State>(unit: StoreWritable<State>): Readonly<Ref<State>>;
export function useUnit<State>(unit: Store<State>): Readonly<Ref<State>>;
export function useUnit<State>(unit: ReactiveWritable<State>): Readonly<Ref<State>>;
export function useUnit<State>(unit: Reactive<State>): Readonly<Ref<State>>;
export function useUnit<Payload>(
  unit: EventCallable<Payload>,
): (...payload: EventPayload<Payload>) => Promise<void>;
export function useUnit<Params, Done, Fail>(
  unit: Effect<Params, Done, Fail>,
): (...args: EffectCallArgs<Params>) => Promise<Done>;
export function useUnit<const Shape extends ShapeSource>(shape: Shape): Bound<Shape>;
export function useUnit<const Shape extends readonly UnitLike[]>(shape: Shape): UnitShape<Shape>;
export function useUnit<const Shape extends Record<string, UnitLike | ShapeSource>>(
  shape: Shape,
): UnitShape<Shape>;
export function useUnit(input: unknown): any {
  const scope = useProvidedScope();

  return bindUnits(input, scope);
}

export function bindUnits(input: unknown, scope: Scope, seen?: WeakSet<object>): unknown {
  if (Array.isArray(input)) {
    return guardShapeNode(input, seen, (path) => input.map((unit) => bindUnits(unit, scope, path)));
  }

  // Units before `getShape`: a reactive store is a Proxy whose arbitrary key
  // reads need an active scope, so `getShape` must never touch one.
  if (isUnitLike(input)) {
    return bindUnit(input, scope);
  }

  // `@@shape` declares the bindable shape of an otherwise opaque value (a class
  // instance, a view-model). Unwrap it and resolve the declaration — which may
  // itself nest further shapes.
  const shape = getShape(input);

  if (shape !== undefined) {
    return guardShapeNode(input as object, seen, (path) => bindUnits(shape, scope, path));
  }

  if (input !== null && typeof input === "object") {
    return guardShapeNode(input as object, seen, (path) => {
      const result: Record<string, unknown> = {};

      for (const key of Object.keys(input)) {
        result[key] = bindUnits((input as Record<string, unknown>)[key], scope, path);
      }

      return result;
    });
  }

  return bindUnit(input as UnitLike, scope);
}

// Guards the recursion against a shape that resolves back onto itself. Nodes are
// tracked along the current path (added on enter, removed on exit), so diamonds
// stay valid and only a genuine cycle throws instead of recursing forever.
function guardShapeNode<T>(
  node: object,
  seen: WeakSet<object> | undefined,
  visit: (path: WeakSet<object>) => T,
): T {
  const path = seen ?? new WeakSet<object>();

  if (path.has(node)) {
    throw new Error("[useUnit] Cyclic @@shape: a shape must not resolve back onto itself.");
  }

  path.add(node);

  try {
    return visit(path);
  } finally {
    path.delete(node);
  }
}

export function bindUnit(unit: UnitLike, scope: Scope): unknown {
  if (isStoreUnit(unit)) {
    return bindStoreRef(unit, scope);
  }

  return (...args: any[]) => scoped(scope, () => (unit as (...rest: any[]) => unknown)(...args));
}

function bindStoreRef<T>(unit: AnyStore<T>, scope: Scope): Readonly<Ref<T>> {
  // Lazy: the store is subscribed only once the ref is actually read (in a
  // template, computed, or watcher). A model field the view never touches — a
  // sub-model's stores included — never subscribes. The disposal hook is
  // registered eagerly so it captures the binding's effect scope even though the
  // subscription itself is installed later.
  let unsubscribe: (() => void) | null = null;
  let disposed = false;
  let cached = readStore(unit, scope);

  const state = customRef<T>((track, trigger) => ({
    get() {
      track();

      // Once the owning scope is disposed the subscription is gone, so freeze at
      // the last observed value rather than reading a store that may since have
      // moved on in another scope.
      if (!disposed) {
        if (!unsubscribe) {
          unsubscribe = unit.subscribe((_value, nextScope) => {
            if (nextScope !== scope) {
              return;
            }

            cached = readStore(unit, scope);
            trigger();
          });
        }

        // Live read: reflects writes that landed before the subscription (or
        // outside any tracking context, e.g. an event handler).
        cached = readStore(unit, scope);
      }

      return cached;
    },
    set() {
      // A bound store ref is read-only; writes go through the unit itself.
    },
  }));

  if (getCurrentVueScope()) {
    onScopeDispose(() => {
      disposed = true;
      unsubscribe?.();
    });
  }

  return state as Readonly<Ref<T>>;
}
