import type { KernelNodeFn, Node } from "./types";
import { registerInspectorNode } from "./inspector";

export type NodeOptions = Node;

export function node(run?: KernelNodeFn): Node;
export function node(options?: NodeOptions): Node;
export function node(input: KernelNodeFn | NodeOptions = {}): Node {
  const created = typeof input === "function" ? { run: input } : { ...input };

  registerInspectorNode(created);

  return created;
}
