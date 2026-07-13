import {
  scoped,
  type Effect,
  type EventCallable,
  type Reactive,
  type ReactiveWritable,
  type Scope,
  type Store,
  type StoreWritable,
} from "@virentia/core";
import { useCallback, useRef, useSyncExternalStore } from "react";
import { useProvidedScope } from "./scope";
import type { AnyStore, Bound, ShapeSource, UnitLike, UnitShape, UnitValue } from "./types";
import { getShape, isStoreUnit, isUnitLike, readStore } from "./utils";

export function useUnit<State>(unit: StoreWritable<State>): State;
export function useUnit<State>(unit: Store<State>): State;
export function useUnit<State>(unit: ReactiveWritable<State>): State;
export function useUnit<State>(unit: Reactive<State>): State;
export function useUnit<Payload>(unit: EventCallable<Payload>): UnitValue<EventCallable<Payload>>;
export function useUnit<Params, Done, Fail>(
  unit: Effect<Params, Done, Fail>,
): UnitValue<Effect<Params, Done, Fail>>;
export function useUnit<const Shape extends ShapeSource>(shape: Shape): Bound<Shape>;
export function useUnit<const Shape extends readonly UnitLike[]>(shape: Shape): UnitShape<Shape>;
export function useUnit<const Shape extends Record<string, UnitLike | ShapeSource>>(
  shape: Shape,
): UnitShape<Shape>;
export function useUnit(input: unknown): any {
  const scope = useProvidedScope();

  return useUnitWithScope(input, scope);
}

export function useUnitWithScope(input: unknown, scope: Scope, seen?: WeakSet<object>): unknown {
  if (Array.isArray(input)) {
    return guardShapeNode(input, seen, (path) =>
      input.map((unit) => useUnitWithScope(unit, scope, path)),
    );
  }

  // Units before `getShape`: a reactive store is a Proxy whose arbitrary key
  // reads need an active scope, so `getShape` must never touch one.
  if (isUnitLike(input)) {
    return useSingleUnit(input, scope);
  }

  // `@@shape` declares the bindable shape of an otherwise opaque value (a class
  // instance, a view-model). Unwrap it and resolve the declaration — which may
  // itself nest further shapes.
  const shape = getShape(input);

  if (shape !== undefined) {
    return guardShapeNode(input as object, seen, (path) => useUnitWithScope(shape, scope, path));
  }

  if (input !== null && typeof input === "object") {
    return guardShapeNode(input as object, seen, (path) => {
      const result: Record<string, unknown> = {};

      for (const key of Object.keys(input)) {
        result[key] = useUnitWithScope((input as Record<string, unknown>)[key], scope, path);
      }

      return result;
    });
  }

  return useSingleUnit(input as UnitLike, scope);
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

function useSingleUnit(unit: UnitLike, scope: Scope): unknown {
  if (isStoreUnit(unit)) {
    return useStoreUnit(unit, scope);
  }

  return useCallback(
    (...args: any[]) => scoped(scope, () => (unit as (...args: any[]) => unknown)(...args)),
    [scope, unit],
  );
}

function useStoreUnit<T>(unit: AnyStore<T>, scope: Scope): T {
  const snapshotRef = useRef(readStore(unit, scope));

  snapshotRef.current = readStore(unit, scope);

  const subscribe = useCallback(
    (notify: () => void) => {
      const unsubscribe = unit.subscribe((_value, nextScope) => {
        if (nextScope !== scope) {
          return;
        }

        snapshotRef.current = readStore(unit, scope);
        notify();
      });

      snapshotRef.current = readStore(unit, scope);

      return unsubscribe;
    },
    [scope, unit],
  );

  const getSnapshot = useCallback(() => snapshotRef.current, []);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
