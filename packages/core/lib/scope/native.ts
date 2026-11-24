import type { Scope } from "./types";
import type { ModelScopeBinding } from "./snapshot";
import type { ScopeEdges } from "../kernel/scoped-edges";
import { topologyChanged, topologyShrank } from "../kernel/topology";
import { retainShapes } from "../kernel/shapes";

/** A transaction's writes to a scope without native slots. */
export interface StagedScopeWrites {
  transaction: object;
  writes: unknown[];
}

/** A computed's state, tagged with its computed's slot (see ComputedStateCache). */
export interface SlottedComputedState {
  slot: number;
}

const initialCacheSize = 256;

function emptyEntries(size: number): undefined[] {
  const entries: undefined[] = [];
  for (let index = 0; index < size; index++) entries.push(undefined);
  return entries;
}
const maxCacheSize = 1 << 16;

/**
 * Direct-mapped cache in front of `values` for computed states of a root scope.
 * A computed with many dependencies, or many computeds over one source, look
 * their state up on every read and update; in a large `values` Map those
 * lookups miss the CPU caches. An entry is the very object `values` holds, so
 * the Map stays the source of truth: a miss (or a collision, which also grows
 * the table) falls back to it.
 */
export class ComputedStateCache {
  entries: (SlottedComputedState | undefined)[] = emptyEntries(initialCacheSize);
  mask = initialCacheSize - 1;
  collisions = 0;

  store(slot: number, state: SlottedComputedState): void {
    const index = slot & this.mask;
    // A quarter of the table in collisions: most states of a large graph are
    // stored while it is built, and every state a collision evicts misses once.
    if (this.entries[index] !== undefined && ++this.collisions > this.entries.length >> 2)
      this.grow();
    state.slot = slot;
    this.entries[slot & this.mask] = state;
  }

  forget(slot: number): void {
    const index = slot & this.mask;
    if (this.entries[index]?.slot === slot) this.entries[index] = undefined;
  }

  private grow(): void {
    this.collisions = 0;
    const previous = this.entries;
    if (previous.length >= maxCacheSize) return;
    const size = previous.length * 2;
    this.entries = emptyEntries(size);
    this.mask = size - 1;
    for (const state of previous)
      if (state !== undefined) this.entries[state.slot & this.mask] = state;
  }
}

/** Private scope-owned slots do not leak or get copied by object spread. */
export class NativeModelScope implements Scope {
  /** Root scopes only: model instance scopes keep few computed states. */
  computedStates: ComputedStateCache | undefined = undefined;
  #model?: ModelScopeBinding;
  #edges?: ScopeEdges;
  // The open transaction's writes to this scope (kernel/transaction.ts).
  #stagedIn: object | undefined = undefined;
  #stagedWrites: unknown[] | undefined = undefined;
  // Model field write routes into this instance scope (models/definition.ts).
  #ownWrites: unknown[] | undefined = undefined;
  constructor(
    public values: Scope["values"],
    public handlers: Scope["handlers"],
    public deps: Scope["deps"],
  ) {}

  /** Drop a released computed's cached state (its `values` entry is gone). */
  static forgetComputedState(scope: Scope, identity: unknown): void {
    // A remembered walk may hold the state being dropped (units/store.ts `TargetCache`).
    topologyShrank();
    const cache = (scope as NativeModelScope).computedStates;
    const slot = (identity as { computedSlot?: unknown } | null)?.computedSlot;
    if (cache !== undefined && typeof slot === "number") cache.forget(slot);
  }

  static readModel(
    scope: Scope,
    fallback: WeakMap<Scope, ModelScopeBinding>,
  ): ModelScopeBinding | undefined {
    return #model in scope ? scope.#model : fallback.get(scope);
  }
  static writeModel(
    scope: Scope,
    binding: ModelScopeBinding,
    fallback: WeakMap<Scope, ModelScopeBinding>,
  ): void {
    if (#model in scope) scope.#model = binding;
    else fallback.set(scope, binding);
  }
  static releaseModel(scope: Scope, fallback: WeakMap<Scope, ModelScopeBinding>): void {
    if (#model in scope) scope.#model = undefined;
    else fallback.delete(scope);
  }
  static readEdges(scope: Scope, fallback: WeakMap<Scope, ScopeEdges>): ScopeEdges | undefined {
    return #edges in scope ? scope.#edges : fallback.get(scope);
  }
  static writeEdges(scope: Scope, edges: ScopeEdges, fallback: WeakMap<Scope, ScopeEdges>): void {
    topologyChanged();
    if (#edges in scope) scope.#edges = edges;
    else fallback.set(scope, edges);
  }
  static releaseEdges(scope: Scope, fallback: WeakMap<Scope, ScopeEdges>): void {
    topologyShrank();
    if (#edges in scope) scope.#edges = undefined;
    else fallback.delete(scope);
  }
  static ownWrites(scope: Scope, fallback: WeakMap<Scope, unknown[]>): unknown[] | undefined {
    return #ownWrites in scope ? scope.#ownWrites : fallback.get(scope);
  }
  static setOwnWrites(
    scope: Scope,
    routes: unknown[] | undefined,
    fallback: WeakMap<Scope, unknown[]>,
  ): void {
    if (#ownWrites in scope) scope.#ownWrites = routes;
    else if (routes) fallback.set(scope, routes);
    else fallback.delete(scope);
  }
  /** Writes `transaction` staged in `scope`, if any. */
  static stagedWrites(
    scope: Scope,
    transaction: object,
    fallback: WeakMap<Scope, StagedScopeWrites>,
  ): unknown[] | undefined {
    if (#stagedIn in scope)
      return scope.#stagedIn === transaction ? scope.#stagedWrites : undefined;
    const staged = fallback.get(scope);
    return staged?.transaction === transaction ? staged.writes : undefined;
  }
  static stageWrites(
    scope: Scope,
    transaction: object | undefined,
    writes: unknown[] | undefined,
    fallback: WeakMap<Scope, StagedScopeWrites>,
  ): void {
    if (#stagedIn in scope) {
      scope.#stagedIn = transaction;
      scope.#stagedWrites = writes;
    } else if (transaction && writes) fallback.set(scope, { transaction, writes });
    else fallback.delete(scope);
  }
}

let nativeScopeIds = 0;

/** Native scopes keep propagation state private, including when frozen or copied. */
export class NativeScope extends NativeModelScope {
  /** Names this root in caches that must not retain it (see units/store.ts `pureIn`). */
  readonly id = ++nativeScopeIds;
  constructor(values: Scope["values"], handlers: Scope["handlers"], deps: Scope["deps"]) {
    super(values, handlers, deps);
    this.computedStates = new ComputedStateCache();
  }
}

// Instance scopes die with their instances, root scopes with their app: keep
// their hidden classes (see kernel/shapes.ts).
retainShapes(
  "core/scope/native",
  new NativeModelScope(new Map(), new Map(), new Map()),
  new NativeScope(new Map(), new Map(), new Map()),
);
