import { topologyChanged, topologyShrank } from "./topology";
import type { Node } from "./types";
import type { Scope } from "../scope";
import { NativeScope } from "../scope/native";
import { retainShapes } from "./shapes";

// Dynamic (auto-tracked) edges are per-scope, unlike the static `node.next`
// topology: two units may read different sources in different scopes, so a
// global edge set would clobber (reactions) or over-subscribe (computed). Keyed
// by `Scope` in a `WeakMap`, so an abandoned scope's edges are GC'd with it and
// `disposeScopeEdges` drops them in O(1). Both directions are kept so
// propagation and reconciliation are each a single `Map` lookup.
interface ManyScopeEdges {
  // source node -> dependents that read it in this scope
  forward: Map<Node, Linked>;
  // dependent node -> sources it read in this scope (for reconcile/teardown)
  reverse: Map<Node, Linked>;
}
// Most nodes of a big scope link to one other node (a reaction reading one
// store): that one is kept as is, and a Set only from the second on.
type Linked = Node | Set<Node>;

// A component often has one fixed source and one DOM binding. Keep that edge
// directly until a second edge actually requires the two-way index.
interface SingleScopeEdge {
  source: Node;
  dependent: Node;
  observers?: Set<Node>;
}
const sharedEdge = Symbol("virentia.sharedScopeEdge");
class SharedScopeEdge implements SingleScopeEdge {
  declare readonly [sharedEdge]: true;
  declare observers?: Set<Node>;
  constructor(
    readonly source: Node,
    readonly dependent: Node,
  ) {
    Object.freeze(this);
  }
  // Most edges checked are per-scope literals: a missing prototype marker
  // answers faster than a failed `#x in` brand check.
  static is(edge: SingleScopeEdge): boolean {
    return (edge as Partial<SharedScopeEdge>)[sharedEdge] === true;
  }
}
Object.defineProperty(SharedScopeEdge.prototype, sharedEdge, { value: true });

/**
 * A few edges as flat `[source, dependent, …]` pairs in creation order. A model
 * instance scope usually holds two or three (fields read by DOM bindings, a
 * computed's source): scanning them is cheaper than two `Map` indexes plus a
 * `Set` per node. It never hands out a live observer handle; asking for one
 * promotes the scope to the two-way index.
 */
class SmallScopeEdges {
  constructor(
    public pairs: Node[],
    /** Used slots: two per edge. */
    public size: number,
  ) {}
}
/** Slots of a small edge list: eight edges. */
const smallSlots = 16;
// Edges die with their scopes: keep their hidden classes (see kernel/shapes.ts).
retainShapes(
  "core/kernel/scoped-edges",
  new SharedScopeEdge({} as Node, {} as Node),
  new SmallScopeEdges([], 0),
);

/** @internal Immutable topology only; observer handles are still materialized per scope. */
export function sharedScopedEdge(source: Node, dependent: Node): SingleScopeEdge {
  return new SharedScopeEdge(source, dependent);
}
type InitialEdge = SingleScopeEdge | ((source: Node) => SingleScopeEdge);
export type ScopeEdges = ManyScopeEdges | SingleScopeEdge | SmallScopeEdges;

const edgesByScope = new WeakMap<Scope, ScopeEdges>();

/** Receives the observers of one source; returning `false` stops the walk. */
export interface ScopedObserverVisitor {
  visitScopedObserver(observer: Node): boolean;
}

/**
 * @internal Visit the dependents that read `source` in `scope`, in edge order,
 * without materializing an observer handle. `false` if the visitor stopped.
 */
export function visitScopedObservers(
  scope: Scope,
  source: Node,
  visitor: ScopedObserverVisitor,
): boolean {
  const edges = NativeScope.readEdges(scope, edgesByScope);
  if (edges === undefined) return true;
  if (edges instanceof SmallScopeEdges) {
    const pairs = edges.pairs;
    for (let index = 0; index < edges.size; index += 2)
      if (pairs[index] === source && !visitor.visitScopedObserver(pairs[index + 1])) return false;
    return true;
  }
  let observers: Linked | undefined;
  if ("source" in edges) {
    if (edges.source !== source) return true;
    observers = edges.observers;
    if (observers === undefined) return visitor.visitScopedObserver(edges.dependent);
  } else observers = edges.forward.get(source);
  if (observers instanceof Set) {
    for (const observer of observers) if (!visitor.visitScopedObserver(observer)) return false;
  } else if (observers !== undefined) return visitor.visitScopedObserver(observers);
  return true;
}

/** @internal Visit the sources `dependent` read in `scope`. */
export function visitScopedSources(
  scope: Scope,
  dependent: Node,
  visit: (source: Node) => void,
): void {
  const edges = NativeScope.readEdges(scope, edgesByScope);
  if (edges === undefined) return;
  if (edges instanceof SmallScopeEdges) {
    const pairs = edges.pairs;
    for (let index = 0; index < edges.size; index += 2)
      if (pairs[index + 1] === dependent) visit(pairs[index]);
    return;
  }
  if ("source" in edges) {
    const observers = edges.observers;
    if (observers === undefined ? edges.dependent === dependent : observers.has(dependent))
      visit(edges.source);
    return;
  }
  const sources = edges.reverse.get(dependent);
  if (sources instanceof Set) for (const source of sources) visit(source);
  else if (sources !== undefined) visit(sources);
}

/**
 * @internal The only dependent reading `source` in `scope`: `undefined` when
 * there is none, `null` when there are several.
 */
export function soleScopedObserver(scope: Scope, source: Node): Node | null | undefined {
  const edges = NativeScope.readEdges(scope, edgesByScope);
  if (edges === undefined) return undefined;
  let observers: Linked | undefined;
  if (edges instanceof SmallScopeEdges) {
    const pairs = edges.pairs;
    let sole: Node | undefined;
    for (let index = 0; index < edges.size; index += 2)
      if (pairs[index] === source) {
        if (sole !== undefined) return null;
        sole = pairs[index + 1];
      }
    return sole;
  }
  if ("source" in edges) {
    if (edges.source !== source) return undefined;
    observers = edges.observers;
    if (observers === undefined) return edges.dependent;
  } else observers = edges.forward.get(source);
  if (!(observers instanceof Set)) return observers;
  if (observers.size === 0) return undefined;
  return observers.size === 1 ? observers.values().next().value! : null;
}

/** A fixed binding needs no temporary iterable or dependency Set. */
export function reconcileScopedSource(
  scope: Scope,
  dependent: Node,
  source: Node,
  single?: InitialEdge,
): void {
  const existing = NativeScope.readEdges(scope, edgesByScope);
  if (source !== dependent && existing !== undefined) {
    if (existing instanceof SmallScopeEdges) {
      if (hasOnlySource(existing, dependent, source)) return;
    } else if (!("source" in existing)) {
      const previous = existing.reverse.get(dependent);
      if (previous === source || (previous instanceof Set && previous.size === 1 && previous.has(source)))
        return;
    }
  }
  if (
    source !== dependent &&
    (existing === undefined || ("source" in existing && existing.dependent === dependent))
  ) {
    replaceSingleEdge(scope, dependent, source, existing, single);
    return;
  }
  // The list is only read before this returns: nothing retains it.
  oneSource[0] = source;
  try {
    reconcileSources(scope, dependent, oneSource, existing, undefined);
  } finally {
    oneSource[0] = undefined!;
  }
}
const oneSource: Node[] = [undefined!];

function hasOnlySource(edges: SmallScopeEdges, dependent: Node, source: Node): boolean {
  const pairs = edges.pairs;
  let found = false;
  for (let index = 0; index < edges.size; index += 2)
    if (pairs[index + 1] === dependent) {
      if (found || pairs[index] !== source) return false;
      found = true;
    }
  return found;
}

function replaceSingleEdge(
  scope: Scope,
  dependent: Node,
  source: Node,
  existing: SingleScopeEdge | undefined,
  single?: InitialEdge,
): void {
  if (!existing)
    NativeScope.writeEdges(
      scope,
      (typeof single === "function" ? single(source) : single) ?? { source, dependent },
      edgesByScope,
    );
  else if (existing.source !== source) {
    if (SharedScopeEdge.is(existing)) {
      NativeScope.writeEdges(scope, { source, dependent }, edgesByScope);
      return;
    }
    existing.observers?.clear();
    existing.source = source;
    existing.observers = undefined;
    topologyChanged();
  }
}

/** Internal presence checks must not materialize an externally mutable observer handle. */
export function hasScopedObservers(scope: Scope, source: Node): boolean {
  const edges = NativeScope.readEdges(scope, edgesByScope);
  if (!edges) return false;
  if (edges instanceof SmallScopeEdges) {
    const pairs = edges.pairs;
    for (let index = 0; index < edges.size; index += 2) if (pairs[index] === source) return true;
    return false;
  }
  if ("source" in edges) {
    if (edges.source !== source) return false;
    const observers = edges.observers;
    return observers === undefined || observers.size > 0;
  }
  const observers = edges.forward.get(source);
  return observers instanceof Set ? observers.size > 0 : observers !== undefined;
}

/** Dependents that read `source` in `scope`, or `undefined` if none. The Set is live. */
export function getScopedObservers(scope: Scope, source: Node): ReadonlySet<Node> | undefined {
  let edges = NativeScope.readEdges(scope, edgesByScope);
  if (!edges) return;
  if (edges instanceof SmallScopeEdges) edges = promote(scope, edges);
  if ("source" in edges && edges.source === source && SharedScopeEdge.is(edges)) {
    const observers = new Set([edges.dependent]);
    NativeScope.writeEdges(scope, { source, dependent: edges.dependent, observers }, edgesByScope);
    return observers;
  }
  if ("source" in edges)
    return edges.source === source ? (edges.observers ??= new Set([edges.dependent])) : undefined;
  // A live handle: a single observer becomes a Set the map keeps.
  const observers = edges.forward.get(source);
  if (observers === undefined || observers instanceof Set) return observers;
  const live = new Set([observers]);
  edges.forward.set(source, live);
  return live;
}

/** @internal Diagnostics: a single edge, a live Set, or a snapshot of a small list. */
export function peekScopedObservers(
  scope: Scope,
  source: Node,
): SingleScopeEdge | ReadonlySet<Node> | undefined {
  const edges = NativeScope.readEdges(scope, edgesByScope);
  if (!edges) return;
  if (edges instanceof SmallScopeEdges) {
    let observers: Set<Node> | undefined;
    for (let index = 0; index < edges.size; index += 2)
      if (edges.pairs[index] === source) (observers ??= new Set()).add(edges.pairs[index + 1]);
    return observers;
  }
  if ("source" in edges) return edges.source === source ? (edges.observers ?? edges) : undefined;
  const observers = edges.forward.get(source);
  return observers === undefined || observers instanceof Set ? observers : new Set([observers]);
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
  const sources =
    nextSources instanceof Set || (Array.isArray(nextSources) && nextSources.length <= smallSlots)
      ? (nextSources as ReadonlySet<Node> | readonly Node[])
      : new Set(nextSources);
  reconcileSources(
    scope,
    dependent,
    sources,
    NativeScope.readEdges(scope, edgesByScope),
    undefined,
  );
}

/** @internal The caller transfers its private Set and must not reuse or mutate it. */
export function reconcileScopedOwnedEdges(scope: Scope, dependent: Node, next: Set<Node>): void {
  next.delete(dependent);
  reconcileSources(scope, dependent, next, NativeScope.readEdges(scope, edgesByScope), next);
}

/**
 * `sources` may contain `dependent` itself and, as an array, duplicates. It is
 * only read; `owned` is the same Set when the caller transferred it.
 */
function reconcileSources(
  scope: Scope,
  dependent: Node,
  sources: ReadonlySet<Node> | readonly Node[],
  existing: ScopeEdges | undefined,
  owned: Set<Node> | undefined,
): void {
  if (existing !== undefined && !(existing instanceof SmallScopeEdges) && !("source" in existing)) {
    reconcileMany(scope, existing, dependent, sources, owned);
    return;
  }
  let count = 0;
  let only: Node | undefined;
  if (Array.isArray(sources)) {
    for (let index = 0; index < sources.length; index++) {
      const source = sources[index];
      if (source !== dependent && sources.indexOf(source) === index) {
        count++;
        only = source;
      }
    }
  } else
    for (const source of sources as ReadonlySet<Node>)
      if (source !== dependent) {
        count++;
        only = source;
      }

  if (existing === undefined || ("source" in existing && existing.dependent === dependent)) {
    if (count === 0) {
      if (existing !== undefined) {
        (existing as SingleScopeEdge).observers?.clear();
        NativeScope.releaseEdges(scope, edgesByScope);
      }
      return;
    }
    if (count === 1) {
      replaceSingleEdge(scope, dependent, only!, existing as SingleScopeEdge | undefined);
      return;
    }
  }

  let pairs: Node[];
  let size: number;
  if (existing === undefined) {
    pairs = noPairs;
    size = 0;
  } else if (existing instanceof SmallScopeEdges) {
    pairs = existing.pairs;
    size = existing.size;
  } else {
    // Another dependent's single edge is untouched by one that reads nothing.
    if (count === 0) return;
    // A handle exposed for this single edge must stay live: index the scope.
    if (existing.observers !== undefined) {
      reconcileMany(scope, ensureScopeEdges(scope), dependent, sources, owned);
      return;
    }
    pairs = [existing.source, existing.dependent];
    size = 2;
  }

  // Drop this dependent's edges to sources it no longer reads, in place.
  let kept = 0;
  for (let index = 0; index < size; index += 2) {
    const source = pairs[index];
    if (pairs[index + 1] === dependent && !includes(sources, source)) continue;
    if (kept !== index) {
      pairs[kept] = source;
      pairs[kept + 1] = pairs[index + 1];
    }
    kept += 2;
  }
  // Then add the sources it newly reads, in their order.
  let used = kept;
  if (Array.isArray(sources)) {
    for (let index = 0; index < sources.length; index++) {
      const source = sources[index];
      if (
        source !== dependent &&
        sources.indexOf(source) === index &&
        !hasPair(pairs, kept, source, dependent)
      )
        used += 2;
    }
  } else
    for (const source of sources as ReadonlySet<Node>)
      if (source !== dependent && !hasPair(pairs, kept, source, dependent)) used += 2;

  if (used > smallSlots) {
    // Too many edges for a list: index the pairs kept so far, then add the rest.
    const many = indexPairs(pairs, kept);
    NativeScope.writeEdges(scope, many, edgesByScope);
    reconcileMany(scope, many, dependent, sources, owned);
    return;
  }
  if (used === 0) {
    NativeScope.releaseEdges(scope, edgesByScope);
    return;
  }
  if (used > pairs.length) {
    const grown = allocatePairs(used);
    for (let index = 0; index < kept; index++) grown[index] = pairs[index];
    pairs = grown;
  }
  if (used !== kept) {
    let at = kept;
    if (Array.isArray(sources)) {
      for (let index = 0; index < sources.length; index++) {
        const source = sources[index];
        if (
          source !== dependent &&
          sources.indexOf(source) === index &&
          !hasPair(pairs, kept, source, dependent)
        ) {
          pairs[at++] = source;
          pairs[at++] = dependent;
        }
      }
    } else
      for (const source of sources as ReadonlySet<Node>)
        if (source !== dependent && !hasPair(pairs, kept, source, dependent)) {
          pairs[at++] = source;
          pairs[at++] = dependent;
        }
  }
  // Unused slots must not retain dropped nodes.
  for (let index = used; index < pairs.length; index++) pairs[index] = undefined!;
  if (existing instanceof SmallScopeEdges) {
    if (used !== kept) topologyChanged();
    else if (kept !== size) topologyShrank();
    existing.pairs = pairs;
    existing.size = used;
  } else NativeScope.writeEdges(scope, new SmallScopeEdges(pairs, used), edgesByScope);
}

const noPairs: Node[] = [];

/** A pair list with room for `slots` entries: 4, 8 or 16 exactly, never growth slack. */
function allocatePairs(slots: number): Node[] {
  const none = undefined!;
  return slots <= 4
    ? [none, none, none, none]
    : slots <= 8
      ? [none, none, none, none, none, none, none, none]
      : [
          none,
          none,
          none,
          none,
          none,
          none,
          none,
          none,
          none,
          none,
          none,
          none,
          none,
          none,
          none,
          none,
        ];
}

function includes(sources: ReadonlySet<Node> | readonly Node[], source: Node): boolean {
  return Array.isArray(sources)
    ? sources.includes(source)
    : (sources as ReadonlySet<Node>).has(source);
}

/** Whether one of the first `size` slots holds the edge (source, dependent). */
function hasPair(pairs: readonly Node[], size: number, source: Node, dependent: Node): boolean {
  for (let index = 0; index < size; index += 2)
    if (pairs[index] === source && pairs[index + 1] === dependent) return true;
  return false;
}

/** The two-way index of the first `size` slots of a pair list. */
function indexPairs(pairs: readonly Node[], size: number): ManyScopeEdges {
  const edges: ManyScopeEdges = { forward: new Map(), reverse: new Map() };
  for (let index = 0; index < size; index += 2) {
    addTo(edges.forward, pairs[index], pairs[index + 1]);
    addTo(edges.reverse, pairs[index + 1], pairs[index]);
  }
  return edges;
}

function promote(scope: Scope, edges: SmallScopeEdges): ManyScopeEdges {
  const many = indexPairs(edges.pairs, edges.size);
  NativeScope.writeEdges(scope, many, edgesByScope);
  return many;
}

/**
 * `sources` may contain `dependent` and, as an array, duplicates; it is only
 * read. `owned` is the same Set when the caller transferred it.
 */
function reconcileMany(
  scope: Scope,
  edges: ManyScopeEdges,
  dependent: Node,
  sources: ReadonlySet<Node> | readonly Node[],
  owned: Set<Node> | undefined,
): void {
  owned?.delete(dependent);
  const previous = edges.reverse.get(dependent);

  if (previous instanceof Set) {
    for (const source of previous) {
      if (!includes(sources, source)) {
        removeFrom(edges.forward, source, dependent);
      }
    }
  } else if (previous !== undefined && !includes(sources, previous))
    removeFrom(edges.forward, previous, dependent);

  let count = 0;
  let only: Node | undefined;
  if (Array.isArray(sources)) {
    for (let index = 0; index < sources.length; index++) {
      const source = sources[index];
      if (source === dependent || sources.indexOf(source) !== index) continue;
      count++;
      only = source;
      if (!linked(previous, source)) addTo(edges.forward, source, dependent);
    }
  } else
    for (const source of sources as ReadonlySet<Node>) {
      if (source === dependent) continue;
      count++;
      only = source;
      if (!linked(previous, source)) addTo(edges.forward, source, dependent);
    }

  if (count === 1) {
    edges.reverse.set(dependent, only!);
  } else if (count > 1) {
    let next = owned;
    if (next === undefined) {
      next = new Set(sources);
      next.delete(dependent);
    }
    edges.reverse.set(dependent, next);
  } else {
    edges.reverse.delete(dependent);
    cleanupScope(scope, edges);
  }
}

/** Remove `dependent` from every source it read in `scope`. */
export function detachScopedDependent(scope: Scope, dependent: Node): void {
  const edges = NativeScope.readEdges(scope, edgesByScope);
  if (edges === undefined) return;
  if (edges instanceof SmallScopeEdges) {
    const pairs = edges.pairs;
    let used = 0;
    for (let index = 0; index < edges.size; index += 2) {
      if (pairs[index + 1] === dependent) continue;
      if (used !== index) {
        pairs[used] = pairs[index];
        pairs[used + 1] = pairs[index + 1];
      }
      used += 2;
    }
    if (used === edges.size) return;
    if (used === 0) {
      NativeScope.releaseEdges(scope, edgesByScope);
      return;
    }
    for (let index = used; index < edges.size; index++) pairs[index] = undefined!;
    edges.size = used;
    topologyShrank();
    return;
  }
  if ("source" in edges) {
    if (edges.dependent === dependent) {
      edges.observers?.clear();
      NativeScope.releaseEdges(scope, edgesByScope);
    }
    return;
  }
  const sources = edges.reverse.get(dependent);

  if (!sources) {
    return;
  }

  if (sources instanceof Set) for (const source of sources) removeFrom(edges.forward, source, dependent);
  else removeFrom(edges.forward, sources, dependent);

  edges.reverse.delete(dependent);
  cleanupScope(scope, edges);
}

/** Drop every dynamic edge of `scope` at once (deterministic teardown). */
export function disposeScopeEdges(scope: Scope): void {
  NativeScope.releaseEdges(scope, edgesByScope);
}

/** The two-way index for a scope holding no edges or a single one. */
function ensureScopeEdges(scope: Scope): ManyScopeEdges {
  let edges = NativeScope.readEdges(scope, edgesByScope) as
    | ManyScopeEdges
    | SingleScopeEdge
    | undefined;

  if (edges && "source" in edges) {
    const observers = edges.observers;
    const forward = new Map<Node, Linked>([[edges.source, observers ?? edges.dependent]]);
    const reverse = new Map<Node, Linked>();
    if (observers) for (const observer of observers) addTo(reverse, observer, edges.source);
    else reverse.set(edges.dependent, edges.source);
    edges = { forward, reverse };
    NativeScope.writeEdges(scope, edges, edgesByScope);
  }

  if (!edges) {
    edges = { forward: new Map(), reverse: new Map() };
    NativeScope.writeEdges(scope, edges, edgesByScope);
  }

  return edges;
}

function cleanupScope(scope: Scope, edges: ManyScopeEdges): void {
  if (edges.forward.size === 0 && edges.reverse.size === 0) {
    NativeScope.releaseEdges(scope, edgesByScope);
  }
}

function linked(links: Linked | undefined, node: Node): boolean {
  return links instanceof Set ? links.has(node) : links === node;
}

function addTo(map: Map<Node, Linked>, key: Node, value: Node): void {
  const linked = map.get(key);

  if (linked === undefined) map.set(key, value);
  else if (linked instanceof Set) {
    if (linked.has(value)) return;
    linked.add(value);
  } else if (linked !== value) {
    // Built up rather than from an array: the iterable constructor is slower.
    const set = new Set<Node>();
    set.add(linked);
    set.add(value);
    map.set(key, set);
  } else return;
  topologyChanged();
}

function removeFrom(map: Map<Node, Linked>, key: Node, value: Node): void {
  const linked = map.get(key);

  if (linked === undefined) {
    return;
  }

  if (!(linked instanceof Set)) {
    if (linked === value) {
      map.delete(key);
      topologyShrank();
    }
    return;
  }

  if (!linked.delete(value)) return;
  topologyShrank();

  // A live handle (getScopedObservers) keeps its Set even when emptied.
  if (linked.size === 0) {
    map.delete(key);
  }
}
