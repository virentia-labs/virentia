import type { DevtoolsSnapshot } from "../../shared/api";

export interface CappedSnapshot {
  snapshot: DevtoolsSnapshot;
  /** How many visible nodes were dropped to stay under the cap (0 = untouched). */
  hiddenCount: number;
  /** Visible node count before capping. */
  totalCount: number;
}

/**
 * Hard cap on how many nodes the flow canvas renders. Real-world effector
 * apps easily discover 20k+ units — ReactFlow freezes the tab long before
 * that (virentia-labs/virentia#8), so past the cap we keep the most
 * informative subset and tell the user to narrow with filters.
 */
export const MAX_RENDERED_NODES = 400;

/**
 * Keep at most `limit` nodes, preferring the informative ones:
 * 1. nodes participating in reactive edges (the actual graph structure),
 * 2. key units (developer-facing stores/events/effects),
 * 3. everything else — in stable snapshot order within each bucket.
 *
 * Edges and breakpoints are filtered down to the surviving nodes.
 */
export function capSnapshot(snapshot: DevtoolsSnapshot, limit = MAX_RENDERED_NODES): CappedSnapshot {
  const totalCount = snapshot.nodes.length;

  if (totalCount <= limit) {
    return { snapshot, hiddenCount: 0, totalCount };
  }

  const connectedIds = new Set<string>();

  for (const edge of snapshot.edges) {
    if (edge.kind === "reactive") {
      connectedIds.add(edge.source);
      connectedIds.add(edge.target);
    }
  }

  const rank = (node: DevtoolsSnapshot["nodes"][number]): number => {
    if (connectedIds.has(node.id)) return 0;
    if (node.key) return 1;
    return 2;
  };

  // Stable sort: Array.prototype.sort is stable per spec — snapshot order is
  // preserved inside each priority bucket.
  const kept = [...snapshot.nodes]
    .map((node, index) => ({ node, index }))
    .sort((a, b) => rank(a.node) - rank(b.node) || a.index - b.index)
    .slice(0, limit)
    .map((entry) => entry.node);

  const keptIds = new Set(kept.map((node) => node.id));

  return {
    snapshot: {
      ...snapshot,
      nodes: kept,
      edges: snapshot.edges.filter(
        (edge) => keptIds.has(edge.source) && keptIds.has(edge.target),
      ),
      breakpoints: snapshot.breakpoints.filter((id) => keptIds.has(id)),
    },
    hiddenCount: totalCount - kept.length,
    totalCount,
  };
}
