import type { Scope } from "./types";
import type { Effect, EffectHandler } from "../units/effect";
import { getNodeCallStackTrace } from "../kernel/call-stack";

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

export function requireActiveScope(describe?: () => string): Scope {
  if (!activeScope) {
    throw scopeRequiredError(describe?.());
  }

  return activeScope;
}

/**
 * Builds the "Scope is required" error.
 *
 * `subject` describes the operation that needed a scope (e.g. `call event
 * "submit"`), so the message names the offending unit instead of failing
 * anonymously, and points at the concrete ways to provide a scope. `describe`
 * thunks are only evaluated on the failure path, so naming a unit costs nothing
 * on the happy path.
 */
export function scopeRequiredError(subject?: string): Error {
  const target = subject ? ` to ${subject}` : "";
  const trace = getNodeCallStackTrace();
  const path =
    trace.length > 0
      ? `\nUnit path that led here: ${trace.join(" → ")}${subject ? ` → ${subject}` : ""}.` +
        " The scope was lost somewhere along this chain (a raw `await` between two units drops it)."
      : "";

  return new Error(
    `Scope is required${target}, but no scope is active.\n` +
      "No scope was passed explicitly and none is active on the current call stack. " +
      "Provide one of the following:\n" +
      "  • Pass a scope explicitly: allSettled(unit, { scope, payload }).\n" +
      "  • Run inside a scoped computation: scoped(scope, () => …), or trigger the unit from within an effect handler.\n" +
      "  • In a component, read and trigger units through the scope Provider (e.g. useUnit) rather than calling them directly." +
      path,
  );
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
