import type {
  DevtoolsGraphEdge,
  DevtoolsGraphNode,
  DevtoolsSnapshot,
} from "@virentia/core/devtools";

export interface ReactiveSelection {
  nodeIds: string[];
  edgeIds: string[];
}

export interface FlowLayoutNode {
  id: string;
  x: number;
  y: number;
}

export function createReactiveSelection(
  snapshot: DevtoolsSnapshot,
  selectedNodeId: string | null,
): ReactiveSelection | null {
  if (!selectedNodeId || !snapshot.nodes.some((node) => node.id === selectedNodeId)) {
    return null;
  }

  const nextByNode = new Map<string, DevtoolsGraphEdge[]>();
  const previousByNode = new Map<string, DevtoolsGraphEdge[]>();
  const nodeIds = new Set<string>([selectedNodeId]);
  const edgeIds = new Set<string>();

  for (const node of snapshot.nodes) {
    nextByNode.set(node.id, []);
    previousByNode.set(node.id, []);
  }

  for (const edge of snapshot.edges) {
    nextByNode.get(edge.source)?.push(edge);
    previousByNode.get(edge.target)?.push(edge);
  }

  // Iterative walks: real-world closures reach tens of thousands of nodes,
  // recursion would overflow the stack on long chains.
  walk(selectedNodeId, nextByNode, (edge) => edge.target);
  walk(selectedNodeId, previousByNode, (edge) => edge.source);

  return {
    nodeIds: [...nodeIds],
    edgeIds: [...edgeIds],
  };

  function walk(
    startId: string,
    edgesByNode: Map<string, DevtoolsGraphEdge[]>,
    step: (edge: DevtoolsGraphEdge) => string,
  ): void {
    const visited = new Set<string>([startId]);
    const stack = [startId];

    nodeIds.add(startId);

    while (stack.length) {
      const nodeId = stack.pop() as string;

      for (const edge of edgesByNode.get(nodeId) ?? []) {
        const next = step(edge);

        edgeIds.add(edge.id);
        nodeIds.add(next);

        if (!visited.has(next)) {
          visited.add(next);
          stack.push(next);
        }
      }
    }
  }
}

export function createFlowLayout(snapshot: DevtoolsSnapshot): FlowLayoutNode[] {
  const nextByNode = new Map<string, string[]>();

  for (const node of snapshot.nodes) {
    nextByNode.set(node.id, []);
  }

  for (const edge of snapshot.edges) {
    nextByNode.get(edge.source)?.push(edge.target);
  }

  // Effector graphs are not DAGs — feedback loops (store → event → store) are
  // idiomatic, and a naive longest-path relaxation loops forever on them: each
  // pass around a cycle raises every level by one. Iterative DFS instead:
  // back edges (to a node still on the DFS stack) are dropped, the reverse
  // finishing order is a topological order of the remaining DAG.
  const state = new Map<string, "on-stack" | "done">();
  const forwardByNode = new Map<string, string[]>();
  const finished: string[] = [];

  for (const root of snapshot.nodes) {
    if (state.has(root.id)) {
      continue;
    }

    const stack: Array<{ id: string; nextIndex: number }> = [{ id: root.id, nextIndex: 0 }];

    state.set(root.id, "on-stack");
    forwardByNode.set(root.id, []);

    while (stack.length) {
      const frame = stack[stack.length - 1];
      const targets = nextByNode.get(frame.id) ?? [];

      if (frame.nextIndex >= targets.length) {
        state.set(frame.id, "done");
        finished.push(frame.id);
        stack.pop();
        continue;
      }

      const target = targets[frame.nextIndex];

      frame.nextIndex += 1;

      if (state.get(target) === "on-stack") {
        continue;
      }

      forwardByNode.get(frame.id)?.push(target);

      if (!state.has(target)) {
        state.set(target, "on-stack");
        forwardByNode.set(target, []);
        stack.push({ id: target, nextIndex: 0 });
      }
    }
  }

  // Longest path over the DAG: relax targets in topological order.
  const levelByNode = new Map<string, number>();

  for (const node of snapshot.nodes) {
    levelByNode.set(node.id, 0);
  }

  for (let index = finished.length - 1; index >= 0; index -= 1) {
    const nodeId = finished[index];
    const level = levelByNode.get(nodeId) ?? 0;

    for (const target of forwardByNode.get(nodeId) ?? []) {
      if ((levelByNode.get(target) ?? 0) < level + 1) {
        levelByNode.set(target, level + 1);
      }
    }
  }

  const levels = new Map<number, DevtoolsGraphNode[]>();

  for (const node of snapshot.nodes) {
    const level = levelByNode.get(node.id) ?? 0;
    const group = levels.get(level) ?? [];

    group.push(node);
    levels.set(level, group);
  }

  return snapshot.nodes.map((node) => {
    const level = levelByNode.get(node.id) ?? 0;
    const group = levels.get(level) ?? [];
    const index = group.findIndex((item) => item.id === node.id);

    return {
      id: node.id,
      x: level * 220,
      y: index * 86,
    };
  });
}
