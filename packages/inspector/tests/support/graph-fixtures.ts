import type {
  DevtoolsGraphEdge,
  DevtoolsGraphNode,
  DevtoolsSnapshot,
} from "@virentia/core/devtools";

/** A graph node with sensible defaults; only `id` matters to the layout/selection code. */
export function node(id: string, over: Partial<DevtoolsGraphNode> = {}): DevtoolsGraphNode {
  return {
    id,
    name: id,
    type: "store",
    key: true,
    callable: false,
    writable: false,
    internal: false,
    meta: {},
    ...over,
  };
}

/** A directed edge; its id encodes the endpoints so tests can reference it. */
export function edge(
  source: string,
  target: string,
  kind: "reactive" | "owner" = "reactive",
): DevtoolsGraphEdge {
  return { id: `${kind}:${source}->${target}`, source, target, kind };
}

export function snapshot(
  nodes: DevtoolsGraphNode[],
  edges: DevtoolsGraphEdge[] = [],
): DevtoolsSnapshot {
  return { nodes, edges, scopes: [], breakpoints: [] };
}
