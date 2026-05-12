import type { KernelNodeFn, Node } from "./types";
import { registerInspectorNode } from "./inspector";

export type CreateNodeOptions = Node;

export function createNode(run?: KernelNodeFn): Node;
export function createNode(options?: CreateNodeOptions): Node;
export function createNode(input: KernelNodeFn | CreateNodeOptions = {}): Node {
  const node = typeof input === "function" ? { run: input } : { ...input };

  registerInspectorNode(node);

  return node;
}
