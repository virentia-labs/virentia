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
import { useTrackedTree, walkUnit } from "./tracked";
import type { AnyStore, Bound, ShapeSource, UnitLike, UnitShape, UnitValue } from "./types";
import { isStoreUnit, isUnitLike, readStore } from "./utils";

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

export function useUnitWithScope(input: unknown, scope: Scope): unknown {
  // A single unit is bound directly: a store to its value, a callable to a
  // scoped invoker. Both are what the caller explicitly asked for, so there is
  // nothing to track — only a shape/object/array can carry fields to ignore.
  if (isUnitLike(input)) {
    return useSingleUnit(input, scope);
  }

  // Every other input is a container (array, `@@shape` source, plain object).
  // One tracked tree subscribes lazily: the component re-renders only for the
  // leaves it actually reads, not for every store the shape happens to expose.
  return useTrackedTree(input, scope, walkUnit);
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
