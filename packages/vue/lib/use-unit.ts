import {
  scoped,
  type Effect,
  type EffectCallArgs,
  type EventCallable,
  type EventPayload,
  type Scope,
  type Store,
  type StoreWritable,
} from "@virentia/core";
import { getCurrentScope as getCurrentVueScope, onScopeDispose, shallowRef, type Ref } from "vue";
import { useProvidedScope } from "./scope";
import type { UnitLike, UnitShape } from "./types";
import { isStoreUnit, isUnitLike, readStore } from "./utils";

export function useUnit<State>(unit: StoreWritable<State>): Readonly<Ref<State>>;
export function useUnit<State>(unit: Store<State>): Readonly<Ref<State>>;
export function useUnit<Payload>(
  unit: EventCallable<Payload>,
): (...payload: EventPayload<Payload>) => Promise<void>;
export function useUnit<Params, Done, Fail>(
  unit: Effect<Params, Done, Fail>,
): (...args: EffectCallArgs<Params>) => Promise<Done>;
export function useUnit<const Shape extends readonly UnitLike[]>(shape: Shape): UnitShape<Shape>;
export function useUnit<const Shape extends Record<string, UnitLike>>(
  shape: Shape,
): UnitShape<Shape>;
export function useUnit(input: UnitLike | readonly UnitLike[] | Record<string, UnitLike>): any {
  const scope = useProvidedScope();

  return bindUnits(input, scope);
}

export function bindUnits(
  input: UnitLike | readonly UnitLike[] | Record<string, UnitLike>,
  scope: Scope,
): unknown {
  if (Array.isArray(input)) {
    return (input as readonly UnitLike[]).map((unit) => bindUnit(unit, scope));
  }

  if (isUnitLike(input)) {
    return bindUnit(input, scope);
  }

  const result: Record<string, unknown> = {};

  for (const key of Object.keys(input)) {
    result[key] = bindUnit((input as Record<string, UnitLike>)[key], scope);
  }

  return result;
}

export function bindUnit(unit: UnitLike, scope: Scope): unknown {
  if (isStoreUnit(unit)) {
    return bindStoreRef(unit, scope);
  }

  return (...args: any[]) => scoped(scope, () => (unit as (...rest: any[]) => unknown)(...args));
}

function bindStoreRef<T>(unit: Store<T> | StoreWritable<T>, scope: Scope): Readonly<Ref<T>> {
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
