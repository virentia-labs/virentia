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
import { getCurrentScope as getCurrentVueScope, onScopeDispose, shallowRef, type Ref } from "vue";
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
    return guardShapeNode(input, seen, (path) =>
      input.map((unit) => bindUnits(unit, scope, path)),
    );
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
  const state = shallowRef<T>(readStore(unit, scope));
  const unsubscribe = unit.subscribe((_value, nextScope) => {
    if (nextScope !== scope) {
      return;
    }

    state.value = readStore(unit, scope);
  });

  // Re-read once: a write may have landed between the initial snapshot and the
  // subscription being installed.
  state.value = readStore(unit, scope);

  if (getCurrentVueScope()) {
    onScopeDispose(unsubscribe);
  }

  return state as Readonly<Ref<T>>;
}
