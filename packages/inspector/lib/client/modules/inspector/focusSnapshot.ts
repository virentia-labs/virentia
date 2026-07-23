import type { DevtoolsSnapshot } from "../../shared/api";
import { createReactiveSelection } from "../../shared/graph";

/**
 * Narrow the snapshot down to the reactive closure of one unit: everything
 * that (transitively) triggers it and everything that depends on it. This is
 * the "debug one unit" view — on real apps the full graph has thousands of
 * nodes, the closure usually has dozens.
 *
 * Returns null when there is nothing to focus (no id or unknown id) so the
 * caller falls back to the unfocused snapshot.
 */
export function focusSnapshot(
  snapshot: DevtoolsSnapshot,
  focusedNodeId: string | null,
): DevtoolsSnapshot | null {
  const selection = createReactiveSelection(snapshot, focusedNodeId);

  if (!selection) {
    return null;
  }

  const keptIds = new Set(selection.nodeIds);

  return {
    ...snapshot,
    nodes: snapshot.nodes.filter((node) => keptIds.has(node.id)),
    edges: snapshot.edges.filter(
      (edge) => keptIds.has(edge.source) && keptIds.has(edge.target),
    ),
    breakpoints: snapshot.breakpoints.filter((id) => keptIds.has(id)),
  };
}
