import type { Node } from "./types";
import type { Scope } from "../scope";

// Dynamic (auto-tracked) edges are per-scope, unlike the static `node.next`
// topology: two units may read different sources in different scopes, so a
// global edge set would clobber (reactions) or over-subscribe (computed). Keyed
// by `Scope` in a `WeakMap`, so an abandoned scope's edges are GC'd with it and
// `disposeScopeEdges` drops them in O(1). Both directions are kept so
// propagation and reconciliation are each a single `Map` lookup.
interface ScopeEdges {
  // source node -> dependents that read it in this scope
  forward: Map<Node, Set<Node>>;
  // dependent node -> sources it read in this scope (for reconcile/teardown)
  reverse: Map<Node, Set<Node>>;
}

const edgesByScope = new WeakMap<Scope, ScopeEdges>();

/** Dependents that read `source` in `scope`, or `undefined` if none. */
export function getScopedObservers(scope: Scope, source: Node): ReadonlySet<Node> | undefined {
  return edgesByScope.get(scope)?.forward.get(source);
}

/**
 * Reconcile the full dependency set of `dependent` in `scope` to exactly
 * `nextSources`. Edges present before but absent now are detached; new ones are
 * attached. This is the per-scope analogue of the old global `reconcileDependencies`.
 */
export function reconcileScopedEdges(
  scope: Scope,
  dependent: Node,
  nextSources: Iterable<Node>,
): void {
  const edges = ensureScopeEdges(scope);
  const previous = edges.reverse.get(dependent);
  const next = toSet(nextSources);

  next.delete(dependent);

  if (previous) {
    for (const source of previous) {
      if (!next.has(source)) {
        removeFrom(edges.forward, source, dependent);
      }
    }
  }

  for (const source of next) {
    if (!previous?.has(source)) {
      addTo(edges.forward, source, dependent);
    }
  }

  if (next.size > 0) {
    edges.reverse.set(dependent, next);
  } else {
    edges.reverse.delete(dependent);
    cleanupScope(scope, edges);
  }
}

/** Remove `dependent` from every source it read in `scope`. */
export function detachScopedDependent(scope: Scope, dependent: Node): void {
  const edges = edgesByScope.get(scope);
  const sources = edges?.reverse.get(dependent);

  if (!edges || !sources) {
    return;
  }

  for (const source of sources) {
    removeFrom(edges.forward, source, dependent);
  }

  edges.reverse.delete(dependent);
  cleanupScope(scope, edges);
}

/** Drop every dynamic edge of `scope` at once (deterministic teardown). */
export function disposeScopeEdges(scope: Scope): void {
  edgesByScope.delete(scope);
}

function ensureScopeEdges(scope: Scope): ScopeEdges {
  let edges = edgesByScope.get(scope);

  if (!edges) {
    edges = { forward: new Map(), reverse: new Map() };
    edgesByScope.set(scope, edges);
  }

  return edges;
}

function cleanupScope(scope: Scope, edges: ScopeEdges): void {
  if (edges.forward.size === 0 && edges.reverse.size === 0) {
    edgesByScope.delete(scope);
  }
}

function toSet(values: Iterable<Node>): Set<Node> {
  return values instanceof Set ? new Set(values) : new Set(values);
}

function addTo(map: Map<Node, Set<Node>>, key: Node, value: Node): void {
  let set = map.get(key);

  if (!set) {
    set = new Set();
    map.set(key, set);
  }

  set.add(value);
}

function removeFrom(map: Map<Node, Set<Node>>, key: Node, value: Node): void {
  const set = map.get(key);

  if (!set) {
    return;
  }

  set.delete(value);

  if (set.size === 0) {
    map.delete(key);
  }
}
