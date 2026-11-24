import type { Scope } from "./types";
import type { Effect, EffectHandler } from "../units/effect";
import { getNodeCallStackTrace } from "../kernel/call-stack";
import { scopePromise } from "./promise";
import { unwrapMicroScope } from "./micro";

let activeScope: Scope | null = null;
// The real scope behind the ambient one (see unwrapMicroScope), resolved on its
// first use after the ambient scope changes; `undefined` until then. A unit
// without a context of its own is read and written in exactly this scope, and
// a computation reads many units between two changes of the ambient scope.
let activeRealScope: Scope | null | undefined = null;

export function getActiveScope(): Scope | null {
  return activeScope;
}

/** `unwrapMicroScope(getActiveScope())`, resolved once per ambient scope. */
export function getActiveRealScope(): Scope | null {
  return activeRealScope !== undefined
    ? activeRealScope
    : (activeRealScope = unwrapMicroScope(activeScope));
}

export function setActiveScope(scope: Scope | null): Scope | null {
  const previousScope = activeScope;

  activeScope = scope;
  activeRealScope = undefined;

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

export function runScopeTask<T>(scope: Scope | null, fn: () => T): T {
  const previousScope = setActiveScope(scope);
  let result: T;

  try {
    result = fn();
  } finally {
    setActiveScope(previousScope);
  }

  if (isPromiseLike(result)) {
    return scopePromise(result, previousScope) as T;
  }

  return result;
}

/** @internal Native model getters keep the usual async handoff without callback closures. */
export function readScopeTaskValue<T>(
  scope: Scope,
  unit: { readonly value: T },
  native?: ((scope?: Scope, modelRead?: boolean) => T) & { api: object },
): T {
  const previousScope = setActiveScope(scope);
  let result: T;
  try {
    // A live API membership probe may re-enter and replace the ambient scope.
    // Resolve it only after that probe, keeping custom getters' native receiver.
    result = native
      ? "value" in native.api
        ? Reflect.get(native.api, "value", unit) as T
        : native(getActiveScope() ?? undefined, true)
      : unit.value;
  } finally {
    setActiveScope(previousScope);
  }
  return isPromiseLike(result) ? (scopePromise(result, previousScope) as T) : result;
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
      "  • Run inside a scoped computation: scoped(scope, () => …) — its promise waits for the work it triggers.\n" +
      "  • Trigger the unit from within an effect handler.\n" +
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
