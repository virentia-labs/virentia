import {
  unitKind,
  type AnyUnit,
  type Effect,
  type EffectState,
  type Event,
  type Scope,
  type Store,
  type StoreWritable,
  type UnitTargetable,
} from "./types";

export const is = {
  unit(value: unknown): value is AnyUnit {
    return isUnit(value);
  },
  event(value: unknown): value is Event<any> {
    return isEvent(value);
  },
  store(value: unknown): value is Store<any> {
    return isStore(value);
  },
  effect(value: unknown): value is Effect<any, any, any> {
    return isEffect(value);
  },
  domain(value: unknown): boolean {
    return Boolean(value && typeof value === "object" && "__domainState" in value);
  },
  attached(value: unknown): boolean {
    return Boolean(
      value &&
      (typeof value === "object" || typeof value === "function") &&
      "__attached" in value &&
      (value as { __attached?: boolean }).__attached,
    );
  },
  targetable(value: unknown): value is UnitTargetable {
    return isTargetable(value);
  },
};

export function isUnit(value: unknown): value is AnyUnit {
  return Boolean(
    value &&
      (typeof value === "object" || typeof value === "function") &&
      (unitKind in value || "__domainState" in value),
  );
}

export function isEvent(value: unknown): value is Event<any> {
  return isUnit(value) && value[unitKind] === "event";
}

export function isStore(value: unknown): value is StoreWritable<any> {
  return isUnit(value) && value[unitKind] === "store";
}

export function isEffect(value: unknown): value is EffectState<any, any, any> {
  return isUnit(value) && value[unitKind] === "effect";
}

export function isTargetable(value: unknown): value is UnitTargetable {
  return isUnit(value) && value.targetable === true;
}

export function isScope(value: unknown): value is Scope {
  return Boolean(value && typeof value === "object" && "__core" in value && !(unitKind in value));
}

export function isScopeError(error: unknown): boolean {
  return error instanceof Error && error.message === "Scope is required";
}
