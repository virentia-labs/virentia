import type { Scope } from "./types";
import { unwrapMicroScope } from "./micro";

const active = new WeakMap<Scope, number>();
const idle = new WeakMap<Scope, Set<() => void>>();

/** @internal A recycled instance scope must not change owners under parked unit code. */
export function retainScopeTask(scope: Scope | null | undefined): () => void {
  if (!scope) return () => {};
  const real = unwrapMicroScope(scope);
  active.set(real, (active.get(real) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const count = (active.get(real) ?? 1) - 1;
    if (count) { active.set(real, count); return; }
    active.delete(real);
    const callbacks = idle.get(real);
    idle.delete(real);
    for (const callback of callbacks ?? []) queueMicrotask(callback);
  };
}

// Callbacks for idle scopes run together in one later microtask: disposing
// many instances in one task schedules one microtask, not one per instance.
let laterCallbacks: (() => void)[] | undefined;
function runLaterCallbacks(): void {
  const callbacks = laterCallbacks!;
  laterCallbacks = undefined;
  for (const callback of callbacks) {
    try {
      callback();
    } catch (error) {
      // Like separate microtasks: one failure is reported, the rest still run.
      queueMicrotask(() => {
        throw error;
      });
    }
  }
}
/** @internal Run `callback` in a later microtask, batched with its neighbours. */
export function queueLater(callback: () => void): void {
  if (laterCallbacks) laterCallbacks.push(callback);
  else {
    laterCallbacks = [callback];
    queueMicrotask(runLaterCallbacks);
  }
}

export function whenScopeIdle(scope: Scope, callback: () => void): void {
  const real = unwrapMicroScope(scope);
  if (!active.get(real)) { queueLater(callback); return; }
  let callbacks = idle.get(real);
  if (!callbacks) idle.set(real, callbacks = new Set());
  callbacks.add(callback);
}
