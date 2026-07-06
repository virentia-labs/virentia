import type { Scope } from "./types";
import type { Node } from "../kernel/types";

// A micro-scope is a lightweight per-reaction-run overlay: it shares the real
// scope's value/handler maps by reference (no copy — cheap to create), and adds
// a private dependency accumulator for exactly one reaction run.
//
// Tracking is hung off the *scope* rather than a separate global collector on
// purpose: the kernel already restores the ambient scope across effect `await`s
// (a reentrant `run()` restores its caller's scope), so a scope-carried
// accumulator survives `await` too. That is what lets an async reaction body
// keep tracking dependencies read *after* an `await`.
interface MicroInfo {
  parent: Scope;
  deps: Set<Node>;
}

const microScopes = new WeakMap<Scope, MicroInfo>();

/** Creates a fresh micro-scope over `parent` (a real scope). */
export function createMicroScope(parent: Scope): Scope {
  const realParent = unwrapMicroScope(parent);
  const micro: Scope = { values: realParent.values, handlers: realParent.handlers };

  microScopes.set(micro, { parent: realParent, deps: new Set() });

  return micro;
}

export function isMicroScope(scope: Scope | null | undefined): boolean {
  return scope != null && microScopes.has(scope);
}

/** The real scope behind a micro-scope (or the scope itself if it is not one). */
export function unwrapMicroScope<T extends Scope | null>(scope: T): T {
  if (!scope) {
    return scope;
  }

  const info = microScopes.get(scope);

  return (info ? (info.parent as T) : scope) as T;
}

/** Records a node the current reaction run directly read. */
export function trackMicroDependency(scope: Scope, node: Node): void {
  microScopes.get(scope)?.deps.add(node);
}

/** The dependency set collected by a micro-scope run. */
export function readMicroDependencies(scope: Scope): ReadonlySet<Node> | undefined {
  return microScopes.get(scope)?.deps;
}
