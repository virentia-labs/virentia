import type { Scope } from "./types";
import type { Effect, EffectHandler } from "../units/effect";

let activeScope: Scope | null = null;

export function getActiveScope(): Scope | null {
  return activeScope;
}

export function setActiveScope(scope: Scope | null): Scope | null {
  const previousScope = activeScope;

  activeScope = scope;

  return previousScope;
}

export function runScopeFrame<T>(scope: Scope, fn: () => T): T {
  const previousScope = setActiveScope(scope);

  try {
    return fn();
  } finally {
    setActiveScope(previousScope);
  }
}

export function runScopeTask<T>(scope: Scope, fn: () => T): T {
  const previousScope = setActiveScope(scope);
  let result: T;

  try {
    result = fn();
  } catch (error) {
    setActiveScope(previousScope);
    throw error;
  }

  if (isPromiseLike(result)) {
    return Promise.resolve(result).finally(() => {
      setActiveScope(previousScope);
    }) as T;
  }

  setActiveScope(previousScope);
  return result;
}

export function requireActiveScope(): Scope {
  if (!activeScope) {
    throw new Error("Scope is required");
  }

  return activeScope;
}

export function getScopeHandler<Params, Done>(
  scope: Scope,
  effect: Effect<Params, Done, any>,
): EffectHandler<Params, Done> | undefined {
  return scope.handlers.get(effect) as EffectHandler<Params, Done> | undefined;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") && value !== null && "then" in value
  );
}
