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
import type { AnyStore, UnitLike, UnitShape, UnitValue } from "./types";
import { isStoreUnit, isUnitLike, readStore } from "./utils";

export function useUnit<State>(unit: StoreWritable<State>): State;
export function useUnit<State>(unit: Store<State>): State;
export function useUnit<State>(unit: ReactiveWritable<State>): State;
export function useUnit<State>(unit: Reactive<State>): State;
export function useUnit<Payload>(unit: EventCallable<Payload>): UnitValue<EventCallable<Payload>>;
export function useUnit<Params, Done, Fail>(
  unit: Effect<Params, Done, Fail>,
): UnitValue<Effect<Params, Done, Fail>>;
export function useUnit<const Shape extends readonly UnitLike[]>(shape: Shape): UnitShape<Shape>;
export function useUnit<const Shape extends Record<string, UnitLike>>(
  shape: Shape,
): UnitShape<Shape>;
export function useUnit(input: UnitLike | readonly UnitLike[] | Record<string, UnitLike>): any {
  const scope = useProvidedScope();

  return useUnitWithScope(input, scope);
}

export function useUnitWithScope(
  input: UnitLike | readonly UnitLike[] | Record<string, UnitLike>,
  scope: Scope,
): unknown {
  if (Array.isArray(input)) {
    return (input as readonly UnitLike[]).map((unit) => useSingleUnit(unit, scope));
  }

  if (isUnitLike(input)) {
    return useSingleUnit(input, scope);
  }

  const result: Record<string, unknown> = {};

  for (const key of Object.keys(input)) {
    result[key] = useSingleUnit(input[key], scope);
  }

  return result;
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
