import type { KernelNodeFn, Node } from "./types";
import { registerInspectorNode } from "./inspector";
import type { Scope } from "../scope/types";

let scopeResolver: ((scope: Scope) => Scope) | undefined;

/** @internal Declare a native singleton graph without wrapping its units. */
export function withNodeScopeResolver<T>(resolve: (scope: Scope) => Scope, body: () => T): T {
  const previous = scopeResolver;
  scopeResolver = resolve;
  try {
    return body();
  } finally {
    scopeResolver = previous;
  }
}

export type NodeOptions = Node;

export function node(run?: KernelNodeFn): Node;
export function node(options?: NodeOptions): Node;
export function node(input: KernelNodeFn | NodeOptions = {}): Node {
  const created = typeof input === "function" ? { run: input } : { ...input };
  return registerOwnedNode(created);
}

/** @internal The caller just allocated this node and will not reuse its options. */
export function registerOwnedNode<T extends Node>(created: T): T {
  prepareOwnedNode(created);

  registerInspectorNode(created);

  return created;
}

/** @internal Capture declaration scope now; instrumentation can be installed later. */
export function prepareOwnedNode<T extends Node>(created: T): T {
  if (scopeResolver && !created.resolveScope) created.resolveScope = scopeResolver;
  return created;
}
