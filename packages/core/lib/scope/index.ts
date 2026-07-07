import { getActiveScope, requireActiveScope, setActiveScope } from "./internal";
import type { Scope } from "./types";
import { beginSpawnCollection } from "../kernel";
import { registerInspectorScope } from "../kernel/inspector";
import type { Effect, EffectHandler } from "../units/effect";
import { seedScopeStoreValue } from "../units/store";
import type { StoreWritable } from "../units/store";
import { provideDependency } from "../units/dependency";
import type { Dependency } from "../units/dependency";

export interface ScopeOptions {
  values?:
    | ReadonlyMap<StoreWritable<any>, unknown>
    | readonly (readonly [StoreWritable<any>, unknown])[];
  handlers?:
    | ReadonlyMap<Effect<any, any, any>, EffectHandler<any, any>>
    | readonly (readonly [Effect<any, any, any>, EffectHandler<any, any>])[];
  deps?: ReadonlyMap<Dependency<any>, unknown> | readonly (readonly [Dependency<any>, unknown])[];
}

export function scope(options: ScopeOptions = {}): Scope {
  const nextScope: Scope = {
    values: new Map(),
    handlers: new Map(),
    deps: new Map(),
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

  if (options.deps) {
    const deps = options.deps instanceof Map ? options.deps.entries() : options.deps;

    for (const [dep, value] of deps) {
      provideDependency(nextScope, dep, value);
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
    return runScopedExec(
      requireActiveScope(() => "use scoped()"),
      scopeOrFn,
    );
  }

  if (scopeOrFn && maybeFn) {
    return runScopedExec(scopeOrFn, maybeFn);
  }

  return createScopedRunner(scopeOrFn ?? requireActiveScope(() => "use scoped()"));
}

export type * from "./types";

type AnyFunction = (this: unknown, ...args: any[]) => unknown;

/**
 * Runs `fn` with `scope` as the ambient scope. The ambient stays installed across
 * `fn`'s own awaits (so a write after `await` still lands in `scope`), then is
 * restored to what it was before.
 *
 * A synchronous `fn` restores immediately and returns its value. An asynchronous
 * `fn` returns a promise that resolves only after `fn` AND every async unit it
 * triggered from its synchronous body (a store write firing a reaction, an effect
 * call, …) have fully settled — only then is the ambient restored. That wait is
 * what stops a detached reaction from outliving the `scoped(...)` and clobbering
 * the global ambient afterwards. (Work spawned only after one of `fn`'s own awaits
 * is not tracked — trigger it before you await, or from an awaited unit.)
 */
function runScopedExec<T>(scope: Scope, fn: () => T): T {
  const stopCollecting = beginSpawnCollection();
  const previousScope = setActiveScope(scope);
  let result: T;

  try {
    result = fn();
  } catch (error) {
    stopCollecting();
    setActiveScope(previousScope);
    throw error;
  }

  const spawned = stopCollecting();

  if (!isThenable(result)) {
    setActiveScope(previousScope);
    return result;
  }

  return Promise.resolve(result)
    .then(
      (value) => settleAll(spawned).then(() => value),
      (error) =>
        settleAll(spawned).then(() => {
          throw error;
        }),
    )
    .finally(() => setActiveScope(previousScope)) as T;
}

function settleAll(promises: Promise<void>[]): Promise<void> {
  if (promises.length === 0) return Promise.resolve();

  // Swallow rejections here: a triggered reaction/effect failing is its own
  // channel's concern, not a reason to reject `scoped`.
  return Promise.all(promises.map((promise) => promise.catch(() => {}))).then(() => {});
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") && value !== null && "then" in value
  );
}

function createScopedRunner(scope: Scope): ScopedRunner {
  const run = (<T>(fn: () => T): T => runScopedExec(scope, fn)) as ScopedRunner;

  run.run = run;
  run.wrap = <F extends AnyFunction>(fn: F): F => {
    return function wrapped(this: unknown, ...args: Parameters<F>): ReturnType<F> {
      return run(() => fn.apply(this, args)) as ReturnType<F>;
    } as F;
  };

  return run;
}
