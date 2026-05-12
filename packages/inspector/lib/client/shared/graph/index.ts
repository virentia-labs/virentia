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

  walkForward(selectedNodeId, new Set());
  walkBackward(selectedNodeId, new Set());

  return {
    nodeIds: [...nodeIds],
    edgeIds: [...edgeIds],
  };

  function walkForward(nodeId: string, visited: Set<string>): void {
    if (visited.has(nodeId)) {
      return;
    }

    visited.add(nodeId);
    nodeIds.add(nodeId);

    for (const edge of nextByNode.get(nodeId) ?? []) {
      edgeIds.add(edge.id);
      nodeIds.add(edge.target);
      walkForward(edge.target, visited);
    }
  }

  function walkBackward(nodeId: string, visited: Set<string>): void {
    if (visited.has(nodeId)) {
      return;
    }

    visited.add(nodeId);
    nodeIds.add(nodeId);

    for (const edge of previousByNode.get(nodeId) ?? []) {
      edgeIds.add(edge.id);
      nodeIds.add(edge.source);
      walkBackward(edge.source, visited);
    }
  }
}

export function createFlowLayout(snapshot: DevtoolsSnapshot): FlowLayoutNode[] {
  const incoming = new Map<string, number>();
  const nextByNode = new Map<string, string[]>();

  for (const node of snapshot.nodes) {
    incoming.set(node.id, 0);
    nextByNode.set(node.id, []);
  }

  for (const edge of snapshot.edges) {
    incoming.set(edge.target, (incoming.get(edge.target) ?? 0) + 1);
    nextByNode.get(edge.source)?.push(edge.target);
  }

  const roots = snapshot.nodes.filter((node) => (incoming.get(node.id) ?? 0) === 0);
  const queue = [...(roots.length ? roots : snapshot.nodes)].map((node) => node.id);
  const levelByNode = new Map<string, number>();

  for (const id of queue) {
    levelByNode.set(id, 0);
  }

  while (queue.length) {
    const nodeId = queue.shift() as string;
    const level = levelByNode.get(nodeId) ?? 0;

    for (const next of nextByNode.get(nodeId) ?? []) {
      const nextLevel = Math.max(levelByNode.get(next) ?? 0, level + 1);

      if (nextLevel !== levelByNode.get(next)) {
        levelByNode.set(next, nextLevel);
        queue.push(next);
      }
    }
  }

  for (const node of snapshot.nodes) {
    if (!levelByNode.has(node.id)) {
      levelByNode.set(node.id, 0);
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
