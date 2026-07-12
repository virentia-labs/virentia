import { setActiveScope } from "@virentia/core/internal";
import { scope } from "@virentia/core";
import { fork } from "effector";
import { associate } from "../../lib";

// Test isolation: overlapping concurrent `scoped()` calls (e.g. two bridged effect
// launches into the same scope) can leave the process-global ambient virentia scope
// pointing at a scope after both settle — the nested calls chain their captured
// "previous" scope. Reset it between tests so cross-scope resolution in later tests
// starts from a clean (null) ambient. See suspected-bug note (R-BR-8 ambient leak).
export function resetAmbientScope(): void {
  setActiveScope(null);
}

/** Deterministic-ish flush of the microtask queue plus one macrotask turn. */
export async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) await Promise.resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

export function makeAssociation() {
  const v = scope();
  const e = fork();
  const association = associate({ virentia: v, effector: e });
  return { v, e, association };
}

export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
