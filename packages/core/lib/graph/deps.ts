import type { Node } from "../kernel";
import { getActiveScope } from "../scope/internal";
import { isMicroScope, trackMicroDependency } from "../scope/micro";

type Collector = (node: Node) => void;

let collector: Collector | null = null;

export function trackNode(node: Node): void {
  // Inside a `collectNodes` window (computed evaluation, or a synchronous
  // reaction collect) the node belongs to that collector — and NOT to any
  // ambient micro-scope, so a computed's inner reads don't leak into the
  // reaction that read the computed ("не вглубь").
  if (collector) {
    collector(node);
    return;
  }

  // Otherwise a direct read in a micro-scoped reaction body is a dependency of
  // that reaction run. This path also fires after an `await`, because the
  // micro-scope stays the ambient scope across effect awaits.
  const scope = getActiveScope();

  if (isMicroScope(scope)) {
    trackMicroDependency(scope as NonNullable<typeof scope>, node);
  }
}

export function collectNodes<T>(fn: () => T): { result: T; nodes: Set<Node> } {
  const previousCollector = collector;
  const nodes = new Set<Node>();

  collector = (node) => {
    nodes.add(node);
  };

  try {
    return {
      result: fn(),
      nodes,
    };
  } finally {
    collector = previousCollector;
  }
}
