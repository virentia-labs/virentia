import type { DevtoolsSnapshot } from "../../shared/api";

/**
 * Drop nodes with no reactive edges. Auto-discovered units (effector's
 * `inspectGraph` reports declarations without live links) render as edge-less
 * boxes and drown the actual graph structure — the "Show isolated" toggle
 * off-state removes them, key or not. Parents of surviving nodes are kept so
 * grouping stays intact.
 */
export function hideIsolatedNodes(snapshot: DevtoolsSnapshot): DevtoolsSnapshot {
  const connectedNodeIds = new Set<string>();

  for (const edge of snapshot.edges) {
    if (edge.kind === "reactive") {
      connectedNodeIds.add(edge.source);
      connectedNodeIds.add(edge.target);
    }
  }

  // Nothing to anchor the view on — hiding everything would read as a broken
  // inspector, so an edge-less graph is left as is.
  if (connectedNodeIds.size === 0) {
    return snapshot;
  }

  for (const node of snapshot.nodes) {
    if (node.parentId && connectedNodeIds.has(node.id)) {
      connectedNodeIds.add(node.parentId);
    }
  }

  return {
    ...snapshot,
    breakpoints: snapshot.breakpoints.filter((id) => connectedNodeIds.has(id)),
    edges: snapshot.edges.filter(
      (edge) => connectedNodeIds.has(edge.source) && connectedNodeIds.has(edge.target),
    ),
    nodes: snapshot.nodes.filter((node) => connectedNodeIds.has(node.id)),
  };
}

/** Keep only key units (developer-facing stores/events/effects) — the
 * "Show all units" toggle off-state. */
export function hideNonKeyNodes(snapshot: DevtoolsSnapshot): DevtoolsSnapshot {
  const visibleNodeIds = new Set(snapshot.nodes.filter((node) => node.key).map((node) => node.id));

  return {
    ...snapshot,
    breakpoints: snapshot.breakpoints.filter((id) => visibleNodeIds.has(id)),
    edges: snapshot.edges.filter(
      (edge) => visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target),
    ),
    nodes: snapshot.nodes.filter((node) => visibleNodeIds.has(node.id)),
  };
}
