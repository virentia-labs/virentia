import { getActiveScope, requireActiveScope, runScopeTask } from "./internal";
import type { Scope } from "./types";
import { registerInspectorScope } from "../kernel/inspector";
import type { Effect, EffectHandler } from "../units/effect";
import { seedScopeStoreValue } from "../units/store";
import type { StoreWritable } from "../units/store";

export interface ScopeOptions {
  values?:
    | ReadonlyMap<StoreWritable<any>, unknown>
    | readonly (readonly [StoreWritable<any>, unknown])[];
  handlers?:
    | ReadonlyMap<Effect<any, any, any>, EffectHandler<any, any>>
    | readonly (readonly [Effect<any, any, any>, EffectHandler<any, any>])[];
}

export function scope(options: ScopeOptions = {}): Scope {
  const nextScope = {
    values: new Map(),
    handlers: new Map(),
  };

  if (options.values) {
    const values = options.values instanceof Map ? options.values.entries() : options.values;

    for (const [store, value] of values) {
      seedScopeStoreValue(nextScope, store, value);
    }
  }

  if (options.handlers) {
    const handlers =
      options.handlers instanceof Map ? options.handlers.entries() : options.handlers;

    for (const [effect, handler] of handlers) {
      nextScope.handlers.set(effect, handler as (...args: any[]) => unknown);
    }
  }

  registerInspectorScope(nextScope);

  return nextScope;
}

export function getCurrentScope(): Scope | null {
  return getActiveScope();
}

export type ScopedRunner = (<T>(fn: () => T) => T) & {
  run: <T>(fn: () => T) => T;
  wrap: <F extends AnyFunction>(fn: F) => F;
};

export function scoped(): ScopedRunner;
export function scoped(scope: Scope): ScopedRunner;
export function scoped<T>(fn: () => T): T;
export function scoped<T>(scope: Scope, fn: () => T): T;
export function scoped<T>(scopeOrFn?: Scope | (() => T), maybeFn?: () => T): ScopedRunner | T {
  if (typeof scopeOrFn === "function") {
    return runScopeTask(
      requireActiveScope(() => "use scoped()"),
      scopeOrFn,
    );
  }

  if (scopeOrFn && maybeFn) {
    return runScopeTask(scopeOrFn, maybeFn);
  }

  return createScopedRunner(scopeOrFn ?? requireActiveScope(() => "use scoped()"));
}

export type * from "./types";

type AnyFunction = (this: unknown, ...args: any[]) => unknown;

function createScopedRunner(scope: Scope): ScopedRunner {
  const run = (<T>(fn: () => T): T => runScopeTask(scope, fn)) as ScopedRunner;

  run.run = run;
  run.wrap = <F extends AnyFunction>(fn: F): F => {
    return function wrapped(this: unknown, ...args: Parameters<F>): ReturnType<F> {
      return run(() => fn.apply(this, args)) as ReturnType<F>;
    } as F;
  };

  return run;
}
