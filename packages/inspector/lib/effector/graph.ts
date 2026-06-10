import { createId, type DevtoolsSnapshot } from "@virentia/core/devtools";
import type { DevtoolsGraphEdge, DevtoolsGraphNode, DevtoolsScope } from "@virentia/core/devtools";
import { inspectGraph } from "effector/inspect";
import type { Scope, Subscription } from "effector";
import { classifyKind, classifyNode, isServiceNamed, type NodeClassification } from "./kinds";
import {
  readGraphite,
  type AnyEffectorUnit,
  type EffectorNode,
  type EffectorScopeEntry,
} from "./types";

/** Metadata for a unit we know about but hold no live node for. */
export interface DiscoveredUnit {
  kind?: string;
  name?: string;
  derived: boolean;
  named?: unknown;
}

interface VisibleNode extends NodeClassification {
  id: string;
  name: string;
}

export interface EffectorGraph {
  addUnits(units: readonly AnyEffectorUnit[]): void;
  addScope(scope: Scope, name?: string): EffectorScopeEntry;
  /** Record a unit seen via inspect() so it appears even without `units`. Returns true if new. */
  observe(unit: DiscoveredUnit & { id: string }): boolean;
  scopes(): EffectorScopeEntry[];
  getNode(id: string): EffectorNode | undefined;
  getUnit(id: string): AnyEffectorUnit | undefined;
  getScope(id: string): Scope | undefined;
  snapshot(breakpoints: Iterable<string>): DevtoolsSnapshot;
  dispose(): void;
}

export function createEffectorGraph(options: { onChange?: () => void } = {}): EffectorGraph {
  // Roots the developer explicitly handed us. The live graph is re-walked from
  // these on every snapshot, so late-wired connections are picked up and
  // detached subgraphs naturally drop out (effector has no teardown signal).
  const unitById = new Map<string, AnyEffectorUnit>();
  const scopeEntries = new Map<string, EffectorScopeEntry>();
  const scopeIds = new Map<Scope, string>();
  // Metadata-only units discovered through effector's introspection (no live
  // node, so they show as vertices but carry no edges and cannot be triggered).
  const discovered = new Map<string, DiscoveredUnit>();

  // inspectGraph streams unit declarations as units are created *after* connect.
  const subscription: Subscription = inspectGraph({
    fn: (declaration) => {
      if (declaration.type !== "unit") {
        return;
      }

      const added = recordDiscovered(discovered, String(declaration.id), {
        kind: declaration.kind,
        name: declaration.name,
        derived: Boolean(declaration.derived),
      });

      if (added) {
        options.onChange?.();
      }
    },
  });

  return {
    addUnits(units) {
      let changed = false;

      for (const unit of units) {
        const graphite = readGraphite(unit);

        if (!graphite) {
          continue;
        }

        unitById.set(String(graphite.id), unit);
        changed = true;
      }

      if (changed) {
        options.onChange?.();
      }
    },

    addScope(scope, name) {
      const existing = scopeIds.get(scope);

      if (existing) {
        const entry = scopeEntries.get(existing) as EffectorScopeEntry;

        if (name) {
          entry.name = name;
        }

        return entry;
      }

      const id = createId("scope");
      const entry: EffectorScopeEntry = {
        id,
        scope,
        name: name ?? `scope ${scopeEntries.size + 1}`,
      };

      scopeIds.set(scope, id);
      scopeEntries.set(id, entry);
      options.onChange?.();

      return entry;
    },

    observe(unit) {
      return recordDiscovered(discovered, unit.id, unit);
    },

    scopes() {
      return [...scopeEntries.values()];
    },

    getNode(id) {
      return walkLiveNodes(unitById.values()).get(id);
    },

    getUnit(id) {
      return unitById.get(id);
    },

    getScope(id) {
      return scopeEntries.get(id)?.scope;
    },

    snapshot(breakpoints) {
      return buildSnapshot({
        liveNodes: walkLiveNodes(unitById.values()),
        discovered,
        scopeEntries,
        breakpoints,
      });
    },

    dispose() {
      subscription.unsubscribe();
      unitById.clear();
      scopeEntries.clear();
      scopeIds.clear();
      discovered.clear();
    },
  };
}

function recordDiscovered(
  discovered: Map<string, DiscoveredUnit>,
  id: string,
  next: DiscoveredUnit,
): boolean {
  const previous = discovered.get(id);
  discovered.set(id, {
    kind: next.kind ?? previous?.kind,
    name: next.name ?? previous?.name,
    derived: next.derived || Boolean(previous?.derived),
    named: next.named ?? previous?.named,
  });

  return previous === undefined;
}

/** Walk the whole connected component reachable from the given root units. */
function walkLiveNodes(roots: Iterable<AnyEffectorUnit>): Map<string, EffectorNode> {
  const live = new Map<string, EffectorNode>();
  const stack: EffectorNode[] = [];

  for (const unit of roots) {
    const graphite = readGraphite(unit);

    if (graphite) {
      stack.push(graphite);
    }
  }

  while (stack.length) {
    const node = stack.pop() as EffectorNode;
    const id = String(node.id);

    if (live.has(id)) {
      continue;
    }

    live.set(id, node);

    for (const next of node.next) {
      stack.push(next);
    }

    for (const link of node.family.links) {
      stack.push(link);
    }

    for (const owner of node.family.owners) {
      stack.push(owner);
    }
  }

  return live;
}

function buildSnapshot(input: {
  liveNodes: Map<string, EffectorNode>;
  discovered: Map<string, DiscoveredUnit>;
  scopeEntries: Map<string, EffectorScopeEntry>;
  breakpoints: Iterable<string>;
}): DevtoolsSnapshot {
  const { liveNodes, discovered, scopeEntries } = input;
  const visible = new Map<string, VisibleNode>();

  for (const [id, node] of liveNodes) {
    const classification = classifyNode(node);

    if (classification.internal) {
      continue;
    }

    visible.set(id, {
      ...classification,
      id,
      name: nodeName(node, id),
    });
  }

  // Metadata-only units (from inspectGraph / inspect) we have no live node for.
  for (const [id, unit] of discovered) {
    if (visible.has(id) || liveNodes.has(id)) {
      continue;
    }

    const classification = classifyKind(unit.kind, unit.derived);

    if (classification.internal) {
      continue;
    }

    const service = isServiceNamed(unit.named);

    visible.set(id, {
      ...classification,
      key: classification.key && !service,
      id,
      name: unit.name ?? `${classification.type} #${id}`,
    });
  }

  const edges: DevtoolsGraphEdge[] = [];
  const edgeIds = new Set<string>();
  const parents = new Map<string, { parentId: string; role: string }>();

  const addEdge = (source: string, target: string, kind: DevtoolsGraphEdge["kind"]): void => {
    if (source === target) {
      return;
    }

    const id = `${kind}:${source}->${target}`;

    if (edgeIds.has(id)) {
      return;
    }

    edgeIds.add(id);
    edges.push({ id, source, target, kind });
  };

  // Edges come only from live nodes (real topology). Discovered metadata nodes
  // appear as isolated vertices until their units are passed via `units`.
  for (const id of visible.keys()) {
    const node = liveNodes.get(id);

    if (!node) {
      continue;
    }

    for (const target of flattenVisible(node, visible, liveNodes, "next")) {
      addEdge(id, target, "reactive");
    }

    if (isServiceNamed(node.meta.named)) {
      const owners = flattenVisible(node, visible, liveNodes, "owners");

      for (const owner of owners) {
        addEdge(owner, id, "owner");
      }

      if (owners.length && !parents.has(id)) {
        parents.set(id, { parentId: owners[0], role: node.meta.named as string });
      }
    }
  }

  const nodes: DevtoolsGraphNode[] = [...visible.values()].map((node) => {
    const parent = parents.get(node.id);

    return {
      id: node.id,
      name: node.name,
      type: node.type,
      key: node.key,
      callable: node.callable,
      writable: node.writable,
      internal: node.internal,
      parentId: parent?.parentId,
      parentRole: parent?.role,
      meta: {
        type: node.type,
        name: node.name,
        key: node.key,
        callable: node.callable,
        writable: node.writable,
        internal: node.internal,
      },
    };
  });

  const scopes: DevtoolsScope[] = [...scopeEntries.values()].map((entry) => ({
    id: entry.id,
    name: entry.name ?? entry.id,
  }));

  const breakpoints = [...new Set(input.breakpoints)].filter((id) => visible.has(id));

  return { nodes, edges, scopes, breakpoints };
}

function nodeName(node: EffectorNode, id: string): string {
  return node.meta.name ?? `${node.meta.op ?? "node"} #${id}`;
}

/**
 * Walk `next` (reactive) or `family.owners` (ownership) from a node, flattening
 * through internal operation nodes to reach the nearest visible units.
 */
function flattenVisible(
  start: EffectorNode,
  visible: Map<string, VisibleNode>,
  liveNodes: Map<string, EffectorNode>,
  direction: "next" | "owners",
): string[] {
  const result = new Set<string>();
  const seen = new Set<EffectorNode>();
  const stack = [...neighbors(start, direction)];

  while (stack.length) {
    const node = stack.pop() as EffectorNode;

    if (seen.has(node)) {
      continue;
    }

    seen.add(node);

    const id = String(node.id);

    if (visible.has(id)) {
      result.add(id);
      continue;
    }

    if (!liveNodes.has(id)) {
      continue;
    }

    for (const neighbor of neighbors(node, direction)) {
      stack.push(neighbor);
    }
  }

  return [...result];
}

function neighbors(node: EffectorNode, direction: "next" | "owners"): EffectorNode[] {
  return direction === "next" ? node.next : node.family.owners;
}
