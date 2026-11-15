import type { Scope } from "./types";
import type { Node } from "../kernel/types";
import { retainShapes } from "../kernel/shapes";

// Every store read asks whether the ambient scope is a micro-scope. A missing
// symbol-keyed property is the cheapest negative answer V8 has: a WeakMap
// lookup costs several times more, and a failed private-brand check (`#x in`)
// more still. The marker points at the scope itself, so a Proxy that forwards
// it to a wrapped micro-scope is not mistaken for one.
const microSelf = Symbol("virentia.microScope");

// A micro-scope shares the concrete scope's maps and owns only one run's
// dependency capture.
class MicroScope implements Scope {
  readonly values: Scope["values"];
  readonly handlers: Scope["handlers"];
  readonly deps: Scope["deps"];
  readonly [microSelf]: MicroScope;
  readonly #parent: Scope;
  #captured: Set<Node> | undefined = undefined;
  constructor(parent: Scope) {
    this.values = parent.values;
    this.handlers = parent.handlers;
    this.deps = parent.deps;
    this[microSelf] = this;
    this.#parent = parent;
  }
  static of(scope: unknown): MicroScope | undefined {
    if (typeof scope !== "object" || scope === null) return undefined;
    const micro = (scope as { [microSelf]?: MicroScope })[microSelf];
    return micro === scope ? micro : undefined;
  }
  static parentOf(scope: unknown): Scope | undefined {
    const micro = MicroScope.of(scope);
    return micro && micro.#parent;
  }
  static track(scope: Scope, node: Node): void {
    const micro = MicroScope.of(scope);
    if (micro) (micro.#captured ??= new Set()).add(node);
  }
  static read(scope: Scope): Set<Node> | undefined {
    const micro = MicroScope.of(scope);
    return micro && (micro.#captured ??= new Set());
  }
  static peek(scope: Scope): ReadonlySet<Node> | undefined {
    const micro = MicroScope.of(scope);
    return micro && (micro.#captured ?? emptyDependencies);
  }
  static take(scope: Scope): ReadonlySet<Node> | undefined {
    const micro = MicroScope.of(scope);
    if (!micro) return;
    const dependencies = micro.#captured ?? emptyDependencies;
    micro.#captured = undefined;
    return dependencies;
  }
}
const emptyDependencies: ReadonlySet<Node> = new Set();
// A micro-scope lives for one run: keep its hidden class (see kernel/shapes.ts).
retainShapes(
  "core/scope/micro",
  new MicroScope({ values: new Map(), handlers: new Map(), deps: new Map() }),
);

/** Creates a fresh micro-scope over `parent` (a real scope). */
export function createMicroScope(parent: Scope): Scope {
  return new MicroScope(unwrapMicroScope(parent));
}

export function isMicroScope(scope: Scope | null | undefined): boolean {
  return MicroScope.of(scope) !== undefined;
}

/** The real scope behind a micro-scope (or the scope itself if it is not one). */
export function unwrapMicroScope<T extends Scope | null>(scope: T): T {
  if (!scope) return scope;
  return (MicroScope.parentOf(scope) ?? scope) as T;
}

/** Records a node the current reaction run directly read. */
export function trackMicroDependency(scope: Scope, node: Node): void {
  MicroScope.track(scope, node);
}

/** The dependency set collected by a micro-scope run. */
export function readMicroDependencies(scope: Scope): ReadonlySet<Node> | undefined {
  return MicroScope.read(scope);
}

/** @internal Snapshot after a synchronous read; empty captures need no private Set. */
export function peekMicroDependencies(scope: Scope): ReadonlySet<Node> | undefined {
  return MicroScope.peek(scope);
}

/** @internal Close one synchronous capture without reusing its dependency Set. */
export function takeMicroDependencies(scope: Scope): ReadonlySet<Node> | undefined {
  return MicroScope.take(scope);
}

// Micro-scopes live for one reaction run; keep their hidden class alive (see
// kernel/run.ts).
export const retainedMicroScopeShape: Scope = new MicroScope({
  values: new Map(),
  handlers: new Map(),
  deps: new Map(),
});
