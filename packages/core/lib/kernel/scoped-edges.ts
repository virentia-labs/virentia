import type { Node } from "./types";
import type { Scope } from "../scope";

// Dynamic (auto-tracked) edges are per-scope, unlike the static `node.next`
// topology. Two units may depend on different sources in different scopes
// (data-dependent reads), so a global edge set would either clobber across
// scopes (reactions) or over-subscribe (computed). These edges are keyed by the
// `Scope` object in a `WeakMap`, which gives two properties we want:
//
//   • auto-GC — when a scope is abandoned (e.g. a per-request `fork`), its whole
//     edge table is collected with it, no bookkeeping required;
//   • O(1) deterministic teardown — `disposeScopeEdges(scope)` drops every edge
//     of a scope at once.
//
// Each scope keeps both directions so the hot path (propagation, source→deps)
// and reconciliation (dependent→sources) are each a single `Map` lookup.
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
