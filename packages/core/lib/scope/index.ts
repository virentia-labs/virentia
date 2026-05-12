import { requireActiveScope, runScopeTask } from "./internal";
import type { Scope } from "./types";
import { registerInspectorScope } from "../kernel/inspector";

export function scope(): Scope {
  const nextScope = {
    values: new Map(),
  };

  registerInspectorScope(nextScope);

  return nextScope;
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
    return runScopeTask(requireActiveScope(), scopeOrFn);
  }

  if (scopeOrFn && maybeFn) {
    return runScopeTask(scopeOrFn, maybeFn);
  }

  return createScopedRunner(scopeOrFn ?? requireActiveScope());
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
