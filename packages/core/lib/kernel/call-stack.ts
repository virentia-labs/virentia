import type { Node } from "./types";
import { describeNode } from "./inspector";

// Nodes whose handlers are executing synchronously right now, outermost first.
// The kernel pushes a frame around each node run so a "Scope is required"
// failure can report the chain of units that led to the offending call. The
// stack spans a single synchronous propagation and unwinds at every async
// boundary, so a raw `await` inside a handler detaches from it.
const nodeStack: Node[] = [];

export function pushNodeFrame(node: Node): void {
  nodeStack.push(node);
}

export function popNodeFrame(): void {
  nodeStack.pop();
}

export function getNodeCallStackTrace(): string[] {
  return nodeStack.map(describeNode);
}
