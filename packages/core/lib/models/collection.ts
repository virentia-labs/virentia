import { trackNode } from "../graph/deps";
import { owner, withOwner } from "../graph/owner";
import { setInspectorScopeAlias } from "../kernel/inspector";
import { requireActiveScope, runScopeTask } from "../scope/internal";
import { unwrapMicroScope } from "../scope/micro";
import type { Scope } from "../scope/types";
import { seedScopeStoreValue, store } from "../units/store";
import type { StoreWritable } from "../units/store";
import { Value } from "@sinclair/typebox/value";
import {
  createInstanceFacade,
  createInstanceScope,
  generateId,
  instanceInternalOf,
  instanceOfScope,
  instantiateDynamic,
  registerScopeInstance,
  relationStoreFor,
  runInInstanceContext,
  runInstanceDisposers,
  setBroadcastResolver,
} from "./definition";
import type {
  DescriptorPredicate,
  DescriptorSort,
  InstanceInternal,
  ModelDefinition,
} from "./definition";
import { fieldIn } from "./fields";
import { isUnionTargetLike, resolveInverseOwning, resolveRelationTarget } from "./relations";
import type { RelationDef, UnionTargetLike } from "./relations";
import type { AnyModel, AnyUnionTyped, TypedCollection, TypedUnionCollection } from "./types";

// §6: the collection is get-or-create per (scope, definition), the only creation
// surface and the owner of instances. It is also an unfiltered Query (§8).

const collectionsByScope = new WeakMap<Scope, Map<ModelDefinition, Collection>>();

// Collections are never homed on an instance scope (§3.4): normalize up to the
// nearest application scope through the instance's parent chain.
export function normalizeHomeScope(scope: Scope): Scope {
  let current = unwrapMicroScope(scope);
  let instance = instanceOfScope(current);

  while (instance) {
    current = unwrapMicroScope(instance.parentScope);
    instance = instanceOfScope(current);
  }

  return current;
}

// Collection-lifetime subscriptions must not be captured as cleanups of whatever
// owner happens to be ambient at collection() time — they belong to the
// collection. Registered on a detached root that is never disposed.
const detachedRoot = owner((_dispose, ownerRef) => ({ ownerRef })).ownerRef;

// §3.4: the broadcast router asks for the live instances of a definition in a
// normalized scope; the registry lives here, so it is injected into definition.ts.
setBroadcastResolver((definition, scope) => {
  const home = collectionsByScope.get(scope)?.get(definition);

  if (!home) return [];

  const state = (home as unknown as { "~state": CollectionState })["~state"];

  return [...state.instances.values()];
});

export interface AddOptions {
  replace?: boolean;
}

export interface Collection<Instance extends object = object> extends Query<Instance> {
  readonly "~collection": true;
  readonly model: ModelDefinition;
  readonly scope: Scope;
  add(input: Record<string, unknown>, options?: AddOptions): Instance;
  add(input: readonly Record<string, unknown>[], options?: AddOptions): Instance[];
  get(id: string): Instance | null;
  remove(id: string): void;
  where(predicate: DescriptorPredicate | ((instance: Instance) => boolean)): Query<Instance>;
  sort(by: DescriptorSort): Query<Instance>;
  take(count: number): Query<Instance>;
}

export interface Query<Instance extends object = object> extends Iterable<Instance> {
  /** binding seam (§10.1): marks query-shaped objects for useModel dispatch. */
  readonly "~query"?: true;
  /** binding seam: the scope the query's collection lives in. */
  readonly "~scope"?: Scope;
  /** binding seam: the epoch stores whose bumps can change this query's result. */
  readonly "~versions"?: () => StoreWritable<number>[];
  readonly items: Instance[];
  readonly ids: string[];
  readonly count: number;
  readonly first: Instance | null;
  where(predicate: DescriptorPredicate | ((instance: Instance) => boolean)): Query<Instance>;
  sort(by: DescriptorSort): Query<Instance>;
  take(count: number): Query<Instance>;
  select<T>(descriptor: { field: string }): T[];
  set(descriptor: { field: string }, value: unknown): void;
  remove(id?: string): void;
  toArray(): Instance[];
}

export interface CollectionState {
  definition: ModelDefinition;
  scope: Scope;
  instances: Map<string, InstanceInternal>;
  facades: Map<InstanceInternal, object>;
  /** oldId → newId, alive while the rebound instance is alive (§10.1). */
  forwarding: Map<string, string>;
  /** field → value → ids (eq hash indexes, §7.3). */
  indexes: Map<string, Map<unknown, Set<string>>>;
  /** field → ord index: id → key, sorted view rebuilt lazily on first query (§7.3). */
  ordIndexes: Map<string, OrdIndex>;
  order: string[];
  /** relation → targetId → owner ids. Structural (§7.1): maintained eagerly. */
  relationReverse: Map<string, Map<string, Set<string>>>;
  /** membership/write epoch: reactive terminals read it, mutations bump it (§8). */
  version: StoreWritable<number>;
  /** interned query plans: shape → record with a single-slot (values, result) memo (§8). */
  plans: Map<string, PlanRecord>;
  /** §3.5: recycled instance scopes (static kind) — Scope + Map reused, slot
   * kept, generation bumped. Bounded, so churn-then-idle does not pin memory. */
  freeScopes: { scope: Scope; slot: number; generation: number }[];
}

interface OrdIndex {
  byId: Map<string, unknown>;
  /** null — dirty; rebuilt on first range/sort access after a change. */
  sorted: { ids: string[]; keys: unknown[] } | null;
}

interface PlanRecord {
  version: number;
  values: unknown[] | null;
  internals: InstanceInternal[];
  ids: string[];
  items: object[] | null;
}

// Every collection of a scope, for delete policies and rebind fk rewriting.
const statesByScope = new WeakMap<Scope, Set<CollectionState>>();
// Models targeted by a `children` relation: creation goes through the parent (§5.1).
const ownedModels = new WeakSet<ModelDefinition>();
let creatingViaParent = 0;

// §5.2: a union collection is a view over the variant collections; the factory
// lives in union.ts and is injected here — same seam style as the broadcast
// resolver, so the module graph stays acyclic.
let unionCollectionFactory: ((definition: object, scope: Scope) => unknown) | null = null;

export function setUnionCollectionFactory(factory: typeof unionCollectionFactory): void {
  unionCollectionFactory = factory;
}

export function collection<U extends AnyUnionTyped>(
  definition: U,
  explicitScope?: Scope,
): TypedUnionCollection<U>;
export function collection<M extends AnyModel>(
  definition: M,
  explicitScope?: Scope,
): TypedCollection<M>;
export function collection(definition: ModelDefinition, explicitScope?: Scope): Collection;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function collection(definition: ModelDefinition, explicitScope?: Scope): any {
  const scope = normalizeHomeScope(
    explicitScope ?? requireActiveScope(() => "create collection(Model)"),
  );

  if ((definition as { "~union"?: unknown })["~union"] === true) {
    if (!unionCollectionFactory) {
      throw new Error("[models] union support is not initialized — import from @virentia/core/models");
    }

    return unionCollectionFactory(definition, scope);
  }

  let byModel = collectionsByScope.get(scope);

  if (!byModel) {
    byModel = new Map();
    collectionsByScope.set(scope, byModel);
  }

  const existing = byModel.get(definition);

  if (existing) return existing;

  const created = createCollection(definition, scope);

  byModel.set(definition, created);

  // `Model.create(props)` is sugar over the active scope's collection (§3.1).
  (definition as unknown as Record<string, unknown>)["~createInCollection"] = (
    props: unknown,
  ) => {
    const active = normalizeHomeScope(requireActiveScope(() => "Model.create(props)"));
    const home = collectionsByScope.get(active)?.get(definition);

    if (!home) {
      throw new Error("[models] no collection for this model in the active scope — call collection(Model) first");
    }

    return (home as Collection).add(props as Record<string, unknown>);
  };

  return created;
}

function createCollection(definition: ModelDefinition, scope: Scope): Collection {
  const state: CollectionState = {
    definition,
    scope,
    instances: new Map(),
    facades: new Map(),
    forwarding: new Map(),
    indexes: new Map(),
    ordIndexes: new Map(),
    order: [],
    relationReverse: new Map(),
    version: store<number>(0),
    plans: new Map(),
    freeScopes: [],
  };

  for (const name of definition.relations.keys()) {
    state.relationReverse.set(name, new Map());
  }

  let scopeStates = statesByScope.get(scope);

  if (!scopeStates) {
    scopeStates = new Set();
    statesByScope.set(scope, scopeStates);
  }

  scopeStates.add(state);

  for (const [name, runtime] of definition.fields) {
    if (runtime.def.indexed === "eq") state.indexes.set(name, new Map());
    if (runtime.def.indexed === "ord") state.ordIndexes.set(name, { byId: new Map(), sorted: null });
  }

  // §7.2: one subscription per FIELD maintains indexes and the query epoch for
  // the whole collection — the kernel's (value, scope) callback names the
  // instance. Relations subscribe too: their writes reshape query results.
  if (definition.kind === "static") {
    const subscribeStatic = (name: string, staticStore: StoreWritable<unknown>): void => {
      withOwner(detachedRoot, () =>
        staticStore.subscribe((value, writeScope) => {
          const internal = instanceOfScope(writeScope);

          if (internal && state.instances.get(internal.id) === internal) {
            updateIndexes(state, name, internal.id, value);
            bumpVersion(state);
          }
        }),
      );
    };

    for (const [name, runtime] of definition.fields) {
      subscribeStatic(name, runtime.staticStore as StoreWritable<unknown>);
    }

    for (const [name, runtime] of definition.relations) {
      subscribeStatic(name, runtime.staticStore as StoreWritable<unknown>);
    }
  }

  const facadeOf = (internal: InstanceInternal): object => {
    let facade = state.facades.get(internal);

    if (!facade) {
      facade = createInstanceFacade(internal);
      state.facades.set(internal, facade);
    }

    return facade;
  };

  const self: Collection = Object.assign(createQuery(state, facadeOf, []), {
    "~collection": true as const,
    "~state": state,
    model: definition,
    scope,

    add(input: Record<string, unknown> | readonly Record<string, unknown>[], options?: AddOptions) {
      if (Array.isArray(input)) {
        // §3.1: the batch is atomic — validate everything before mutating, and
        // undo this batch's CREATIONS if an element still fails mid-apply
        // (merged pre-existing instances are not this batch's to dispose).
        for (const entry of input) validateAddInput(state, entry, options);

        const created: object[] = [];

        try {
          return input.map((entry) => {
            const suppliedId = typeof entry.id === "string" ? entry.id : undefined;
            const isCreation = suppliedId === undefined || !state.instances.has(suppliedId);
            const facade = addOne(state, facadeOf, entry, options);

            if (isCreation) created.push(facade);

            return facade;
          });
        } catch (error) {
          for (const facade of created) {
            (facade as { dispose(): void }).dispose();
          }

          throw error;
        }
      }

      validateAddInput(state, input as Record<string, unknown>, options);

      return addOne(state, facadeOf, input as Record<string, unknown>, options);
    },

    get(id: string) {
      // §10.1: get(id) is a REACTIVE view of one instance — a computed or
      // reaction over it re-resolves when membership changes (add, dispose,
      // rebind), returning null instead of throwing mid-read.
      readVersion(state);

      const direct = state.instances.get(id);

      if (direct) return facadeOf(direct);

      // Forwarding is a fallback only — a direct id match always wins (§10.1).
      const forwarded = state.forwarding.get(id);
      const viaForwarding = forwarded ? state.instances.get(forwarded) : undefined;

      return viaForwarding ? facadeOf(viaForwarding) : null;
    },

    remove(id: string) {
      const internal = state.instances.get(id);

      if (internal) disposeInstance(state, internal);
    },
  }) as Collection;

  return self;
}

// Value-typed keys (Date) normalize to a primitive so eq/index buckets work.
function indexKeyOf(value: unknown): unknown {
  return value instanceof Date ? `~date:${value.getTime()}` : value;
}

export function ordKeyOf(value: unknown): unknown {
  return value instanceof Date ? value.getTime() : value;
}

function bumpVersion(state: CollectionState): void {
  runScopeTask(state.scope, () => {
    state.version.value = state.version.value + 1;
  });
}

// Reactive epoch read: track in the CALLER's collector/micro-scope, read in the
// collection's scope — the same split as field facades (§8).
function readVersion(state: CollectionState): number {
  trackNode((state.version as unknown as { node: never }).node);

  return runScopeTask(state.scope, () => state.version.value);
}

function updateIndexes(state: CollectionState, field: string, id: string, value: unknown): void {
  moveInIndex(state, field, id, value);

  const ord = state.ordIndexes.get(field);

  if (ord) {
    ord.byId.set(id, ordKeyOf(value));
    ord.sorted = null;
  }
}

function ordSorted(state: CollectionState, field: string): { ids: string[]; keys: unknown[] } {
  const ord = state.ordIndexes.get(field)!;

  if (!ord.sorted) {
    // §7.3: rebuilt lazily on the first query after a change — a thousand
    // writes in a frame cost one rebuild, not a thousand splices.
    const entries = [...ord.byId.entries()].sort((a, b) =>
      (a[1] as never) < (b[1] as never) ? -1 : (a[1] as never) > (b[1] as never) ? 1 : 0,
    );

    ord.sorted = { ids: entries.map(([id]) => id), keys: entries.map(([, key]) => key) };
  }

  return ord.sorted;
}

function lowerBound(keys: unknown[], value: unknown, strict: boolean): number {
  let low = 0;
  let high = keys.length;

  while (low < high) {
    const mid = (low + high) >>> 1;
    const key = keys[mid] as never;
    const before = strict ? key <= (value as never) : key < (value as never);

    if (before) low = mid + 1;
    else high = mid;
  }

  return low;
}

/** Candidate ids for a range predicate over an ord index, in field order. */
function ordRange(state: CollectionState, predicate: DescriptorPredicate): string[] {
  const { ids, keys } = ordSorted(state, predicate.field);
  const value = ordKeyOf(predicate.value);

  switch (predicate.op) {
    case "gt":
      return ids.slice(lowerBound(keys, value, true));
    case "gte":
      return ids.slice(lowerBound(keys, value, false));
    case "lt":
      return ids.slice(0, lowerBound(keys, value, false));
    case "lte":
      return ids.slice(0, lowerBound(keys, value, true));
    case "between": {
      const from = lowerBound(keys, value, false);
      const to = lowerBound(keys, ordKeyOf(predicate.upper), true);

      return ids.slice(from, to);
    }
    default:
      return ids;
  }
}

const RANGE_OPS = new Set(["gt", "gte", "lt", "lte", "between"]);

function moveInIndex(state: CollectionState, field: string, id: string, next: unknown): void {
  const index = state.indexes.get(field);

  if (!index) return;

  for (const bucket of index.values()) bucket.delete(id);

  const key = indexKeyOf(next);
  let bucket = index.get(key);

  if (!bucket) {
    bucket = new Set();
    index.set(key, bucket);
  }

  bucket.add(id);
}

function dropFromIndexes(state: CollectionState, id: string): void {
  for (const index of state.indexes.values()) {
    for (const bucket of index.values()) bucket.delete(id);
  }

  for (const ord of state.ordIndexes.values()) {
    if (ord.byId.delete(id)) ord.sorted = null;
  }
}

// §3.1: add is an upsert by id. Present keys are authoritative, absent keys
// touch nothing; a partial input with an unknown id is a dev error naming the
// missing keys.
function addOne(
  state: CollectionState,
  facadeOf: (internal: InstanceInternal) => object,
  input: Record<string, unknown>,
  options?: AddOptions,
): object {
  const { definition } = state;
  const suppliedId = typeof input.id === "string" ? input.id : undefined;
  const existing = suppliedId ? state.instances.get(suppliedId) : undefined;

  if (!existing && creatingViaParent === 0 && ownedModels.has(definition)) {
    throw new Error(
      `[models] ${definition.name ?? "this model"} is owned as children — create it through the parent's relation (.add / .create), not directly (§5.1)`,
    );
  }

  if (suppliedId && state.forwarding.has(suppliedId)) {
    // add never consults forwarding — it matches real ids; an input reclaiming a
    // live forwarding key drops that entry with a warning (§10.1).
    // eslint-disable-next-line no-console
    console.warn(`[models] add(): id "${suppliedId}" was a forwarding alias; the alias is dropped`);
    state.forwarding.delete(suppliedId);
  }

  if (existing) {
    mergeInstance(state, existing, input, options);

    return facadeOf(existing);
  }

  return facadeOf(createOne(state, input, suppliedId));
}

function missingRequiredKeys(
  state: CollectionState,
  input: Record<string, unknown>,
  forCreate: boolean,
): string[] {
  const missing: string[] = [];

  for (const [name, runtime] of state.definition.fields) {
    const key = boundKeyOf(name, runtime.def);

    if (key === null) continue;

    if (!(key in input) && !runtime.def.defaultValue && forCreate) {
      missing.push(key);
    }
  }

  return missing;
}

export function validateAddInput(
  state: CollectionState,
  input: Record<string, unknown>,
  options?: AddOptions,
): void {
  const suppliedId = typeof input.id === "string" ? input.id : undefined;
  const exists = suppliedId !== undefined && state.instances.has(suppliedId);
  const missing = missingRequiredKeys(state, input, !exists || Boolean(options?.replace));

  if (missing.length > 0) {
    throw new Error(
      `[models] add(): ${exists ? "replacing" : "creating"} ${state.definition.name ?? "model"} requires missing keys: ${missing.join(", ")}`,
    );
  }

  validateInputSchemas(state, input);
}

// §4.8: the wire input is checked against the TypeBox schema of each present
// bound key — the schema describes the STRUCTURAL wire space. A user `.map`
// takes over the whole conversion, wire shape included, so validation is the
// user's too — their key is skipped.
function validateInputSchemas(state: CollectionState, input: Record<string, unknown>): void {
  for (const [name, runtime] of state.definition.fields) {
    const key = boundKeyOf(name, runtime.def);

    if (key === null || !(key in input)) continue;
    if (runtime.def.binding.in) continue;

    const raw = input[key];

    if (raw === null && runtime.def.optionalValue) continue;

    let ok = true;

    try {
      ok = Value.Check(runtime.def.schema, raw);
    } catch {
      continue; // uninstantiated generic placeholders etc. — nothing to check
    }

    if (!ok) {
      const [first] = [...Value.Errors(runtime.def.schema, raw)];

      throw new Error(
        `[models] add(): invalid "${key}" for ${state.definition.name ?? "model"}${first ? ` — ${first.message} at ${first.path || "value"}` : ""}`,
      );
    }
  }
}

function boundKeyOf(name: string, def: { binding: { key: string | null | false } }): string | null {
  if (def.binding.key === false) return null;

  return def.binding.key === null ? name : def.binding.key;
}

function createOne(
  state: CollectionState,
  input: Record<string, unknown>,
  suppliedId: string | undefined,
): InstanceInternal {
  const { definition, scope } = state;
  const missing: string[] = [];
  const values = new Map<string, unknown>();

  for (const [name, runtime] of definition.fields) {
    const key = boundKeyOf(name, runtime.def);

    if (key !== null && key in input) {
      values.set(name, fieldIn(runtime.def, input[key]));
    } else if (runtime.def.defaultValue) {
      values.set(name, runtime.def.defaultValue.value);
    } else if (key !== null) {
      missing.push(key);
    } else {
      values.set(name, undefined);
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `[models] add(): creating ${definition.name ?? "model"} requires missing keys: ${missing.join(", ")}`,
    );
  }

  const internal = allocateInstance(state, suppliedId);

  if (definition.kind === "static") {
    for (const [name, value] of values) {
      const runtime = definition.fields.get(name)!;

      seedScopeStoreValue(internal.scope!, runtime.staticStore!, value);
      updateIndexes(state, name, internal.id, value);
    }
  } else {
    const { stores, ownOwner, ownerRef } = instantiateDynamic(
      definition,
      scope,
      values,
      input,
      internal,
    );

    internal.ownOwner = ownOwner;

    for (const [name, value] of values) {
      updateIndexes(state, name, internal.id, value);
    }

    // §7.2, dynamic branch: per-instance subscriptions keep indexes and the
    // query epoch fresh; owned by the INSTANCE's owner, so dispose unsubscribes.
    withOwner(ownerRef, () => {
      const subscribeDynamic = (name: string): void => {
        stores.get(name)!.subscribe((value, writeScope) => {
          if (unwrapMicroScope(writeScope) === scope && internal.alive) {
            updateIndexes(state, name, internal.id, value);
            bumpVersion(state);
          }
        });
      };

      for (const name of definition.fields.keys()) subscribeDynamic(name);
      for (const name of definition.relations.keys()) subscribeDynamic(name);
    });
  }

  // Fresh backing per instance — a shared [] default would alias across instances.
  if (definition.kind === "static") {
    for (const [name, runtime] of definition.relations) {
      seedScopeStoreValue(
        internal.scope!,
        runtime.staticStore!,
        runtime.def.cardinality === "many" ? [] : null,
      );
    }
  }

  state.instances.set(internal.id, internal);
  state.order.push(internal.id);

  applyRelationInput(state, internal, input, false);
  bumpVersion(state);

  return internal;
}

let slotCounter = 0;

const FREE_LIST_LIMIT = 1024;

function allocateInstance(state: CollectionState, suppliedId: string | undefined): InstanceInternal {
  const { definition, scope } = state;

  let instanceScope: Scope | undefined;
  let slot: number;
  let generation = 1;

  if (definition.kind === "static") {
    const recycled = state.freeScopes.pop();

    if (recycled) {
      // §3.5: reuse Scope + Map (`clear()` instead of a new one). Values are
      // cleared at REUSE time — a straggler reaction from the previous
      // occupant's last tick saw stale-but-isolated values, never these.
      recycled.scope.values.clear();
      instanceScope = recycled.scope;
      slot = recycled.slot;
      generation = recycled.generation + 1;
    } else {
      slotCounter += 1;
      slot = slotCounter;
      instanceScope = createInstanceScope(scope, definition.locals!);
    }
  } else {
    slotCounter += 1;
    slot = slotCounter;
  }

  const internal: InstanceInternal = {
    definition,
    parentScope: scope,
    scope: instanceScope,
    id: suppliedId ?? generateId(),
    key: `s${slot}g${generation}`,
    slot,
    generation,
    alive: true,
    temporaryId: suppliedId === undefined,

    // §3.5: `alive` reads are reactive at the price of one epoch dependency —
    // dispose bumps the collection version, so watchers degrade without a try.
    onAliveRead: () => {
      readVersion(state);
    },

    onWrite: (name, value) => moveInIndex(state, name, internal.id, value),

    onRebind: (oldId, newId) => {
      if (!internal.alive) return;

      state.instances.delete(oldId);
      state.instances.set(newId, internal);
      state.forwarding.set(oldId, newId);

      // Older aliases stay flat: tmp→A after rebind(A→B) becomes tmp→B, so
      // get() never needs a chain walk and dispose sweeps the whole set (§10.1).
      for (const [aliasId, target] of state.forwarding) {
        if (target === oldId) state.forwarding.set(aliasId, newId);
      }

      const at = state.order.indexOf(oldId);

      if (at >= 0) state.order[at] = newId;

      for (const index of state.indexes.values()) {
        for (const bucket of index.values()) {
          if (bucket.delete(oldId)) bucket.add(newId);
        }
      }

      for (const ord of state.ordIndexes.values()) {
        if (ord.byId.has(oldId)) {
          ord.byId.set(newId, ord.byId.get(oldId));
          ord.byId.delete(oldId);
          ord.sorted = null;
        }
      }

      rewriteRelationIds(state, oldId, newId);
      bumpVersion(state);
      internal.notifySelf?.();
    },

    onDispose: (instance) => disposeInstance(state, instance),
  };

  const viewCache = new Map<string, object>();

  internal.relationView = (name: string) => {
    let view = viewCache.get(name);

    if (!view) {
      view = buildRelationView(state, internal, name);
      viewCache.set(name, view);
    }

    return view;
  };

  // Binding seam (§10.1): one per-instance change feed — own field/relation
  // writes plus dispose/rebind. Store subscriptions attach on first listener
  // and detach with the last, so idle instances cost nothing.
  const selfListeners = new Set<() => void>();
  let detachSelf: (() => void) | null = null;

  const notifySelf = (): void => {
    for (const listener of [...selfListeners]) listener();
  };

  const attachSelf = (): void => {
    const unsubs: Array<() => void> = [];
    const relevant = (writeScope: Scope): boolean =>
      definition.kind === "static"
        ? instanceOfScope(writeScope) === internal
        : unwrapMicroScope(writeScope) === scope && internal.alive;

    withOwner(detachedRoot, () => {
      const subscribeStore = (unit: StoreWritable<unknown>): void => {
        unsubs.push(
          unit.subscribe((_value, writeScope) => {
            if (relevant(writeScope)) notifySelf();
          }),
        );
      };

      if (definition.kind === "static") {
        for (const runtime of definition.fields.values()) {
          subscribeStore(runtime.staticStore as StoreWritable<unknown>);
        }

        for (const runtime of definition.relations.values()) {
          subscribeStore(runtime.staticStore as StoreWritable<unknown>);
        }
      } else {
        for (const unit of internal.ownStores?.values() ?? []) {
          subscribeStore(unit);
        }
      }
    });

    detachSelf = () => {
      for (const unsubscribe of unsubs) unsubscribe();

      detachSelf = null;
    };
  };

  internal.notifySelf = notifySelf;
  internal.subscribeSelf = (listener) => {
    if (selfListeners.size === 0) attachSelf();

    selfListeners.add(listener);

    return () => {
      selfListeners.delete(listener);

      if (selfListeners.size === 0) detachSelf?.();
    };
  };

  internal.serializeRelations = (out) => serializeRelationsOf(state, internal, out);

  if (internal.scope) {
    registerScopeInstance(internal.scope, internal);
  }

  return internal;
}

function mergeInstance(
  state: CollectionState,
  internal: InstanceInternal,
  input: Record<string, unknown>,
  options?: AddOptions,
): void {
  const facade = createInstanceFacadeCached(state, internal);

  const writes: Array<[name: string, value: unknown]> = [];
  const missing: string[] = [];

  for (const [name, runtime] of state.definition.fields) {
    const key = boundKeyOf(name, runtime.def);

    if (key === null) continue;

    const present = key in input;

    if (!present && !options?.replace) continue;

    if (!present && !runtime.def.defaultValue) {
      // §3.1: replace resets absent OPTIONAL keys to defaults; an absent
      // required key is a malformed replace, not permission to write undefined.
      missing.push(key);
      continue;
    }

    const value = present ? fieldIn(runtime.def, input[key]) : runtime.def.defaultValue?.value;

    writes.push([name, value]);
  }

  if (missing.length > 0) {
    throw new Error(
      `[models] add(): replacing ${state.definition.name ?? "model"} requires missing keys: ${missing.join(", ")}`,
    );
  }

  for (const [name, value] of writes) {
    (facade as Record<string, { value: unknown }>)[name].value = value;
  }

  applyRelationInput(state, internal, input, Boolean(options?.replace));

  // Forwarding entries die with their instance; a merge keeps it alive — nothing to do.
}

function createInstanceFacadeCached(state: CollectionState, internal: InstanceInternal): object {
  let facade = state.facades.get(internal);

  if (!facade) {
    facade = createInstanceFacade(internal);
    state.facades.set(internal, facade);
  }

  return facade;
}

function disposeInstance(state: CollectionState, internal: InstanceInternal): void {
  if (!internal.alive) return;

  // restrict must abort BEFORE any state is torn down (§5.1)
  applyDeletePolicies(state, internal);
  cascadeChildren(state, internal);

  // this instance's own outgoing refs release their reverse entries
  for (const [name, runtime] of state.definition.relations) {
    if (runtime.def.relation !== "refs") continue;

    const current = relRead(internal, name);

    if (Array.isArray(current)) {
      for (const entry of current as RelationEntry[]) {
        reverseDrop(state, name, entryIdOf(entry), internal.id);
      }
    } else if (current !== null && current !== undefined) {
      reverseDrop(state, name, entryIdOf(current as RelationEntry), internal.id);
    }
  }

  // §10.4: external cleanups run after the restrict gate, before teardown —
  // the instance is still alive, so a cleanup may read its fields.
  runInstanceDisposers(internal);

  internal.disposedSite = new Error("dispose site");
  internal.alive = false;
  internal.ownOwner?.dispose();
  state.instances.delete(internal.id);
  state.facades.delete(internal);
  dropFromIndexes(state, internal.id);

  const at = state.order.indexOf(internal.id);

  if (at >= 0) state.order.splice(at, 1);

  for (const [oldId, newId] of state.forwarding) {
    if (newId === internal.id) state.forwarding.delete(oldId);
  }

  bumpVersion(state);
  internal.notifySelf?.();

  // §3.5: the scope joins the free list a microtask LATER — a same-tick create
  // must not reuse a scope whose pending reactions may still drain this tick.
  if (internal.scope) {
    const record = { scope: internal.scope, slot: internal.slot, generation: internal.generation };

    queueMicrotask(() => {
      if (state.freeScopes.length < FREE_LIST_LIMIT) state.freeScopes.push(record);
    });
  }
}

// ---------------------------------------------------------------------------
// Queries (§8): descriptor predicates ride the eq/ord indexes, the rest runs as
// a residual scan. Plans are interned by structural key — values are BIND
// PARAMETERS, not part of the key, so a chain rebuilt every render hits the same
// plan; the result memo is a single slot per plan (last values, last epoch),
// which is exactly the render-loop pattern. Terminals are reactive: they read
// the collection epoch through the caller's tracking, so reactions and
// computeds over query results re-run on relevant changes.

type QueryFilter =
  | { kind: "descriptor"; predicate: DescriptorPredicate }
  | { kind: "scan"; predicate: (instance: object) => boolean };

interface QueryPlan {
  filters: QueryFilter[];
  sortBy?: DescriptorSort;
  takeCount?: number;
}

const scanIds = new WeakMap<object, number>();
let nextScanId = 0;

function scanIdOf(fn: (instance: object) => boolean): number {
  let id = scanIds.get(fn);

  if (id === undefined) {
    nextScanId += 1;
    id = nextScanId;
    scanIds.set(fn, id);
  }

  return id;
}

/** Structural plan key (shape only) + bind values, per §8. */
function planShapeOf(plan: QueryPlan): { shape: string; values: unknown[] } {
  const parts: string[] = [];
  const values: unknown[] = [];

  for (const filter of plan.filters) {
    if (filter.kind === "scan") {
      parts.push(`s${scanIdOf(filter.predicate)}`);
    } else {
      parts.push(`d:${filter.predicate.field}:${filter.predicate.op}`);
      values.push(filter.predicate.value);

      if (filter.predicate.op === "between") values.push(filter.predicate.upper);
    }
  }

  if (plan.sortBy) parts.push(`o:${plan.sortBy.field}:${plan.sortBy.direction}`);
  if (plan.takeCount !== undefined) {
    parts.push("t");
    values.push(plan.takeCount);
  }

  return { shape: parts.join("|"), values };
}

export function valuesEqual(a: unknown[] | null, b: unknown[]): boolean {
  if (a === null || a.length !== b.length) return false;

  for (let index = 0; index < a.length; index += 1) {
    if (indexKeyOf(a[index]) !== indexKeyOf(b[index])) return false;
  }

  return true;
}

export function idsEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;

  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }

  return true;
}

function computeInternals(
  state: CollectionState,
  facadeOf: (internal: InstanceInternal) => object,
  plan: QueryPlan,
): InstanceInternal[] {
  const descriptors = plan.filters.filter(
    (filter): filter is Extract<QueryFilter, { kind: "descriptor" }> => filter.kind === "descriptor",
  );

  // Candidate source: the eq hash first (assumed most selective), then an ord
  // range, then the full membership in insertion order (§7.3).
  let consumed: QueryFilter | null = null;
  let ids: string[] = state.order;

  const eqFilter = descriptors.find(
    (filter) => filter.predicate.op === "eq" && state.indexes.has(filter.predicate.field),
  );

  if (eqFilter) {
    const bucket = state.indexes
      .get(eqFilter.predicate.field)!
      .get(indexKeyOf(eqFilter.predicate.value));

    ids = bucket ? state.order.filter((id) => bucket.has(id)) : [];
    consumed = eqFilter;
  } else {
    const rangeFilter = descriptors.find(
      (filter) => RANGE_OPS.has(filter.predicate.op) && state.ordIndexes.has(filter.predicate.field),
    );

    if (rangeFilter) {
      ids = ordRange(state, rangeFilter.predicate);
      consumed = rangeFilter;
    }
  }

  let internals = ids
    .map((id) => state.instances.get(id))
    .filter((internal): internal is InstanceInternal => internal !== undefined);

  for (const filter of plan.filters) {
    if (filter === consumed) continue;

    internals =
      filter.kind === "scan"
        ? internals.filter((internal) => filter.predicate(facadeOf(internal)))
        : internals.filter((internal) => matches(facadeOf(internal), filter.predicate));
  }

  if (plan.sortBy) {
    const { field, direction } = plan.sortBy;

    internals = [...internals].sort((a, b) => {
      const left = ordKeyOf(readField(facadeOf(a), field));
      const right = ordKeyOf(readField(facadeOf(b), field));
      const compared = left === right ? 0 : (left as never) < (right as never) ? -1 : 1;

      return direction === "asc" ? compared : -compared;
    });
  }

  if (plan.takeCount !== undefined) {
    internals = internals.slice(0, plan.takeCount);
  }

  return internals;
}

function createQuery(
  state: CollectionState,
  facadeOf: (internal: InstanceInternal) => object,
  filters: QueryFilter[],
  sortBy?: DescriptorSort,
  takeCount?: number,
): Query {
  const plan: QueryPlan = { filters, sortBy, takeCount };
  const { shape, values } = planShapeOf(plan);

  // Interned by shape; the single-slot memo keys on (values, epoch). Stable
  // identity: an epoch bump that does not change the id sequence keeps the SAME
  // arrays — bindings and React get referential stability for free (§8).
  const resolve = (): PlanRecord => {
    const version = readVersion(state);
    let record = state.plans.get(shape);

    if (record && record.version === version && valuesEqual(record.values, values)) {
      return record;
    }

    const internals = computeInternals(state, facadeOf, plan);
    const ids = internals.map((internal) => internal.id);

    if (record && valuesEqual(record.values, values) && idsEqual(record.ids, ids)) {
      record.version = version;

      return record;
    }

    record = { version, values: [...values], internals, ids, items: null };
    state.plans.set(shape, record);

    return record;
  };

  const query: Query = {
    "~query": true as const,
    "~scope": state.scope,
    "~versions": () => [state.version],

    get items() {
      const record = resolve();

      if (!record.items) {
        record.items = record.internals.map(facadeOf);
      }

      return record.items;
    },

    get ids() {
      return resolve().ids;
    },

    get count() {
      return resolve().internals.length;
    },

    get first() {
      const [head] = resolve().internals;

      return head ? facadeOf(head) : null;
    },

    where(predicate) {
      if (typeof predicate !== "function") assertOwnDescriptor(state, predicate.model, predicate.field);

      const filter: QueryFilter =
        typeof predicate === "function"
          ? { kind: "scan", predicate }
          : { kind: "descriptor", predicate };

      return createQuery(state, facadeOf, [...plan.filters, filter], plan.sortBy, plan.takeCount);
    },

    sort(by) {
      assertOwnDescriptor(state, by.model, by.field);

      return createQuery(state, facadeOf, plan.filters, by, plan.takeCount);
    },

    take(count) {
      return createQuery(state, facadeOf, plan.filters, plan.sortBy, count);
    },

    select(descriptor) {
      return resolve().internals.map((internal) =>
        readField(facadeOf(internal), descriptor.field),
      ) as never;
    },

    set(descriptor, value) {
      for (const internal of resolve().internals) {
        (facadeOf(internal) as Record<string, { value: unknown }>)[descriptor.field].value = value;
      }
    },

    remove() {
      for (const internal of [...resolve().internals]) {
        disposeInstance(state, internal);
      }
    },

    toArray() {
      return [...query.items];
    },

    [Symbol.iterator]() {
      return query.items[Symbol.iterator]();
    },
  };

  return query;
}

function assertOwnDescriptor(
  state: CollectionState,
  model: ModelDefinition | undefined,
  field: string,
): void {
  if (model !== undefined && model !== state.definition) {
    throw new Error(
      `[models] descriptor "${field}" belongs to a different model than this collection (§8) — descriptors are taken from the model being queried`,
    );
  }
}


// ---------------------------------------------------------------------------
// Relations runtime (§5): views on instances, cascade, delete policies, wire.
//
// Storage entries (§5.2): a MODEL-target relation stores plain id strings. A
// UNION-target relation stores pairs { model, id } for instance writes — an id
// alone is ambiguous when variants share ids — while a wire-loaded reference
// stays a bare STRING (unresolved) and resolves by searching the variants at
// first navigation, preserving §5.4 laziness; ambiguity there is a dev error.

export type RelationEntry = string | { model: ModelDefinition; id: string };

function entryIdOf(entry: RelationEntry): string {
  return typeof entry === "string" ? entry : entry.id;
}

function entriesSame(a: RelationEntry | null, b: RelationEntry | null): boolean {
  if (a === null || b === null) return a === b;
  if (typeof a === "string" || typeof b === "string") return a === b;

  return a.id === b.id && a.model === b.model;
}

/** Loose match for removal/policies: an unresolved (string) side matches any variant. */
function entryMatchesLoose(stored: RelationEntry, probe: RelationEntry): boolean {
  if (typeof stored === "string" || typeof probe === "string") {
    return entryIdOf(stored) === entryIdOf(probe);
  }

  return stored.id === probe.id && stored.model === probe.model;
}

function relRead(internal: InstanceInternal, name: string): unknown {
  return runInInstanceContext(internal, () => relationStoreFor(internal, name).value);
}

function relWrite(internal: InstanceInternal, name: string, value: unknown): void {
  runInInstanceContext(internal, () => {
    relationStoreFor(internal, name).value = value;
  });
}

function idOf(target: unknown): string | null {
  if (target === null || target === undefined) return null;
  if (typeof target === "string") return target;

  const id = (target as { id?: unknown }).id;

  if (typeof id === "string") return id;

  throw new Error("[models] relation target must be an instance, an id, or null");
}

function relationIsUnion(def: RelationDef): boolean {
  return isUnionTargetLike(resolveRelationTarget(def));
}

/** Does this relation's target cover the given model (directly or as a variant)? */
function relationTargetsModel(def: RelationDef, model: ModelDefinition): boolean {
  const target = resolveRelationTarget(def);

  return target === model || (isUnionTargetLike(target) && target.variants.includes(model));
}

function targetCollectionOf(state: CollectionState, def: RelationDef): Collection {
  const target = resolveRelationTarget(def);

  if (def.relation === "children") {
    // union children: every variant is owned — creation goes through the parent
    if (isUnionTargetLike(target)) {
      for (const variant of target.variants) ownedModels.add(variant);
    } else {
      ownedModels.add(target);
    }
  }

  // a union target resolves to the union VIEW; it shares the get/add/remove
  // surface this runtime uses
  return collection(target as ModelDefinition, state.scope) as Collection;
}

/** Build the entry a WRITE stores. A bare id stays a bare id — target
 * resolution is navigation-time (§5.4), and for a union target a string IS the
 * unresolved form. An INSTANCE names its variant, so union targets store the
 * precise pair (and validate membership); resolving the target here is fine —
 * an instance write is navigation. */
function toWriteEntry(state: CollectionState, def: RelationDef, next: unknown): RelationEntry | null {
  if (next === null || next === undefined) return null;
  if (typeof next === "string") return next;

  const internal = instanceInternalOf(next as object);

  if (!internal) return idOf(next);
  if (!relationIsUnion(def)) return internal.id;

  const target = resolveRelationTarget(def) as UnionTargetLike;

  if (!target.variants.includes(internal.definition)) {
    throw new Error(
      "[models] the instance's model is not a variant of this relation's union target (§5.2)",
    );
  }

  return { model: internal.definition, id: internal.id };
}

function ambiguousUnionId(id: string): Error {
  return new Error(
    `[models] id "${id}" exists in more than one variant of the union target — an id-only reference cannot disambiguate; write the relation with an instance (§5.2)`,
  );
}

/** Resolve a stored entry to a live instance facade (or null). Resolution is
 * navigation-time: an unresolved (string) union reference searches the
 * variants HERE, and finding it in two of them is a dev error. */
function resolveRelationEntry(
  state: CollectionState,
  def: RelationDef,
  entry: RelationEntry | null | undefined,
): object | null {
  if (entry === null || entry === undefined) return null;

  if (typeof entry !== "string") {
    return (collection(entry.model, state.scope) as Collection).get(entry.id);
  }

  const target = resolveRelationTarget(def);

  if (!isUnionTargetLike(target)) return targetCollectionOf(state, def).get(entry);

  let found: object | null = null;

  for (const variant of target.variants) {
    const hit = (collection(variant, state.scope) as Collection).get(entry);

    if (hit === null) continue;
    if (found !== null) throw ambiguousUnionId(entry);

    found = hit;
  }

  return found;
}

export function stateOfCollection(target: Collection): CollectionState {
  return (target as unknown as { "~state": CollectionState })["~state"];
}

function reverseOf(state: CollectionState, name: string): Map<string, Set<string>> {
  return state.relationReverse.get(name)!;
}

function reverseAdd(state: CollectionState, name: string, targetId: string, ownerId: string): void {
  let bucket = reverseOf(state, name).get(targetId);

  if (!bucket) {
    bucket = new Set();
    reverseOf(state, name).set(targetId, bucket);
  }

  bucket.add(ownerId);
}

function reverseDrop(state: CollectionState, name: string, targetId: string, ownerId: string): void {
  const bucket = reverseOf(state, name).get(targetId);

  if (bucket) {
    bucket.delete(ownerId);

    if (bucket.size === 0) reverseOf(state, name).delete(targetId);
  }
}

function assertUnique(state: CollectionState, name: string, def: RelationDef, targetId: string, ownerId: string): void {
  if (!def.isUnique) return;

  const bucket = reverseOf(state, name).get(targetId);

  if (bucket && (bucket.size > 1 || (bucket.size === 1 && !bucket.has(ownerId)))) {
    throw new Error(
      `[models] unique constraint: relation "${name}" already links target "${targetId}" to another instance (§5.3)`,
    );
  }
}

function setOneRelation(state: CollectionState, internal: InstanceInternal, name: string, def: RelationDef, next: RelationEntry | null): void {
  const previous = (relRead(internal, name) as RelationEntry | null) ?? null;

  if (entriesSame(previous, next)) return;

  if (next !== null) assertUnique(state, name, def, entryIdOf(next), internal.id);
  if (previous !== null) reverseDrop(state, name, entryIdOf(previous), internal.id);

  relWrite(internal, name, next);

  if (next !== null) reverseAdd(state, name, entryIdOf(next), internal.id);
}

function manyEntries(internal: InstanceInternal, name: string): RelationEntry[] {
  return (relRead(internal, name) as RelationEntry[] | undefined) ?? [];
}

function manyIds(internal: InstanceInternal, name: string): string[] {
  return manyEntries(internal, name).map(entryIdOf);
}

function addToMany(state: CollectionState, internal: InstanceInternal, name: string, entry: RelationEntry, at?: number): void {
  const entries = manyEntries(internal, name);
  const existingAt = entries.findIndex((current) => entryMatchesLoose(current, entry));

  if (existingAt >= 0) {
    const existing = entries[existingAt];

    // a concrete pair upgrades an unresolved (string) wire entry in place
    if (typeof existing === "string" && typeof entry !== "string") {
      const next = [...entries];

      next[existingAt] = entry;
      relWrite(internal, name, next);
    }

    return;
  }

  const next = [...entries];

  next.splice(at === undefined ? next.length : at, 0, entry);
  relWrite(internal, name, next);
  reverseAdd(state, name, entryIdOf(entry), internal.id);
}

/** Removes the first entry matching the probe; returns the REMOVED entry. */
function removeFromMany(state: CollectionState, internal: InstanceInternal, name: string, probe: RelationEntry): RelationEntry | null {
  const entries = manyEntries(internal, name);
  const at = entries.findIndex((current) => entryMatchesLoose(current, probe));

  if (at < 0) return null;

  const removed = entries[at];

  relWrite(internal, name, entries.filter((_, index) => index !== at));
  reverseDrop(state, name, entryIdOf(removed), internal.id);

  return removed;
}

/** The entry recorded for a created/merged child: unions record the variant. */
function childEntryOf(def: RelationDef, child: object): RelationEntry {
  const id = (child as { id: string }).id;

  if (!relationIsUnion(def)) return id;

  const internal = instanceInternalOf(child);

  return internal ? { model: internal.definition, id } : id;
}

/** Dispose a child precisely: a pair goes to ITS variant's collection — the
 * union view's id search could hit a same-id instance of another variant. */
function removeChildEntry(state: CollectionState, def: RelationDef, entry: RelationEntry): void {
  if (typeof entry !== "string" && entry.model) {
    (collection(entry.model, state.scope) as Collection).remove(entry.id);

    return;
  }

  targetCollectionOf(state, def).remove(entryIdOf(entry));
}

function buildRelationView(state: CollectionState, internal: InstanceInternal, name: string): object {
  const inverseRuntime = state.definition.inverses.get(name);

  if (inverseRuntime) return buildInverseView(state, internal, inverseRuntime.def);

  const runtime = state.definition.relations.get(name)!;
  const def = runtime.def;
  const target = () => targetCollectionOf(state, def);
  const oneEntry = (): RelationEntry | null => (relRead(internal, name) as RelationEntry | null) ?? null;
  const resolvedItems = (): object[] =>
    manyEntries(internal, name)
      .map((entry) => resolveRelationEntry(state, def, entry))
      .filter((instance): instance is object => instance !== null);

  if (def.relation === "refs" && def.cardinality === "one") {
    return {
      get value(): object | null {
        return resolveRelationEntry(state, def, oneEntry());
      },

      set value(next: unknown) {
        setOneRelation(state, internal, name, def, toWriteEntry(state, def, next));
      },
    };
  }

  if (def.relation === "refs" && def.cardinality === "many") {
    return {
      add: (targetRef: unknown) => {
        const entry = toWriteEntry(state, def, targetRef);

        if (entry !== null) addToMany(state, internal, name, entry);
      },

      remove: (targetRef: unknown) => {
        const probe = toWriteEntry(state, def, targetRef);

        if (probe !== null) removeFromMany(state, internal, name, probe);
      },

      get ids(): string[] {
        return manyIds(internal, name);
      },

      get items(): object[] {
        return resolvedItems();
      },

      get count(): number {
        return manyEntries(internal, name).length;
      },
    };
  }

  if (def.relation === "children" && def.cardinality === "many") {
    return {
      add: (input: Record<string, unknown> | readonly Record<string, unknown>[]) =>
        addChildren(state, internal, name, def, input),

      remove: (childRef: unknown) => {
        const probe = toWriteEntry(state, def, childRef);

        if (probe === null) return;

        const removed = removeFromMany(state, internal, name, probe);

        if (removed !== null) removeChildEntry(state, def, removed);
      },

      move: (childRef: unknown, index: number) => {
        const probe = toWriteEntry(state, def, childRef);

        if (probe === null) return;

        const entries = manyEntries(internal, name);
        const at = entries.findIndex((current) => entryMatchesLoose(current, probe));

        if (at < 0) return;

        const [moved] = entries.splice(at, 1);
        const next = [...entries];

        next.splice(index, 0, moved);
        relWrite(internal, name, next);
      },

      get ids(): string[] {
        return manyIds(internal, name);
      },

      get items(): object[] {
        return resolvedItems();
      },

      get count(): number {
        return manyEntries(internal, name).length;
      },
    };
  }

  // children.one (§5.1): { value, create, clear }
  const clearOne = (): void => {
    const current = oneEntry();

    if (current !== null) {
      relWrite(internal, name, null);
      reverseDrop(state, name, entryIdOf(current), internal.id);
      removeChildEntry(state, def, current);
    }
  };

  return {
    get value(): object | null {
      return resolveRelationEntry(state, def, oneEntry());
    },

    create: (input: Record<string, unknown>) => {
      const current = oneEntry();

      if (current !== null && resolveRelationEntry(state, def, current) !== null) {
        throw new Error(
          `[models] children.one "${name}" already has a live child — clear() it explicitly (§5.1)`,
        );
      }

      const child = createChild(state, internal, name, target(), input);

      relWrite(internal, name, childEntryOf(def, child));

      return child;
    },

    clear: clearOne,
  };
}

function createChild(
  state: CollectionState,
  parent: InstanceInternal,
  name: string,
  target: Collection,
  input: Record<string, unknown>,
): object {
  creatingViaParent += 1;

  try {
    const child = target.add(input) as { id: string };

    reverseAdd(state, name, child.id, parent.id);

    return child;
  } finally {
    creatingViaParent -= 1;
  }
}

function addChildren(
  state: CollectionState,
  parent: InstanceInternal,
  name: string,
  def: RelationDef,
  input: Record<string, unknown> | readonly Record<string, unknown>[],
): object | object[] {
  const target = targetCollectionOf(state, def);
  const one = (entryJson: Record<string, unknown>): object => {
    const child = createChild(state, parent, name, target, entryJson);
    const entry = childEntryOf(def, child);
    const entries = manyEntries(parent, name);

    if (!entries.some((current) => entryMatchesLoose(current, entry))) {
      relWrite(parent, name, [...entries, entry]);
    }

    return child;
  };

  return Array.isArray(input) ? input.map(one) : one(input as Record<string, unknown>);
}

function buildInverseView(
  state: CollectionState,
  internal: InstanceInternal,
  def: import("./relations").InverseDef,
): object {
  const owning = resolveInverseOwning(def);
  const owningRelation = owning.model.relations.get(owning.field);

  if (!owningRelation) {
    throw new Error(
      `[models] inverse() points at "${owning.field}", which is not a relation of the owning model (§5.3)`,
    );
  }

  const owningDef = owningRelation.def;
  const owningCollection = () => collection(owning.model as ModelDefinition, state.scope) as Collection;
  const ownerIds = (): string[] => {
    const owningState = stateOfCollection(owningCollection());
    const bucket = reverseOf(owningState, owning.field).get(internal.id);

    if (!bucket) return [];
    if (!relationIsUnion(owningDef)) return [...bucket];

    // The owning field targets a union and its reverse buckets key by id alone
    // — keep only owners whose stored entry references THIS variant (§5.2).
    const probe: RelationEntry = { model: internal.definition, id: internal.id };
    const filtered: string[] = [];

    for (const ownerId of bucket) {
      const ownerInternal = owningState.instances.get(ownerId);

      if (!ownerInternal) continue;

      const current = relRead(ownerInternal, owning.field);
      const matches = Array.isArray(current)
        ? (current as RelationEntry[]).some((entry) => entryMatchesLoose(entry, probe))
        : current !== null &&
          current !== undefined &&
          entryMatchesLoose(current as RelationEntry, probe);

      if (matches) filtered.push(ownerId);
    }

    return filtered;
  };

  // §5.3: cardinality is derived — children.* and unique refs.one invert to one.
  const invertsToOne =
    owningDef.relation === "children" || (owningDef.cardinality === "one" && owningDef.isUnique);

  if (invertsToOne) {
    return {
      get value(): object | null {
        const [ownerId] = ownerIds();

        return ownerId === undefined ? null : owningCollection().get(ownerId);
      },
    };
  }

  const linkTarget = (ownerRef: unknown): Record<string, unknown> => {
    const ownerId = idOf(ownerRef)!;
    const owner = owningCollection().get(ownerId);

    if (owner === null) {
      throw new Error(`[models] link(): unknown instance "${ownerId}"`);
    }

    return owner as Record<string, unknown>;
  };

  return {
    get ids(): string[] {
      return ownerIds();
    },

    get items(): object[] {
      const bucket = owningCollection();

      return ownerIds()
        .map((id) => bucket.get(id))
        .filter((instance): instance is object => instance !== null);
    },

    get count(): number {
      return ownerIds().length;
    },

    // §5.3: write-through where unambiguous — link/unlink, never add/remove
    // (remove on a Query is mass-dispose, §8). The write passes the INSTANCE:
    // for a union-target owning field a bare id could not name the variant.
    link: (ownerRef: unknown) => {
      const owner = linkTarget(ownerRef);
      const selfFacade = createInstanceFacadeCached(state, internal);

      if (owningDef.cardinality === "one") {
        (owner[owning.field] as { value: unknown }).value = selfFacade;
      } else {
        (owner[owning.field] as { add: (target: unknown) => void }).add(selfFacade);
      }
    },

    unlink: (ownerRef: unknown) => {
      const owner = linkTarget(ownerRef);
      const selfFacade = createInstanceFacadeCached(state, internal);

      if (owningDef.cardinality === "one") {
        // null only a link that actually points at me — unlink is "unlink ME",
        // not "clear whatever the owner points at"
        const view = owner[owning.field] as { value: unknown };

        if (view.value === selfFacade) view.value = null;
      } else {
        (owner[owning.field] as { remove: (target: unknown) => void }).remove(selfFacade);
      }
    },
  };
}

function serializeRelationsOf(state: CollectionState, internal: InstanceInternal, out: Record<string, unknown>): void {
  for (const [name, runtime] of state.definition.relations) {
    const def = runtime.def;
    const key = def.wireKey ?? name;

    if (def.relation === "refs") {
      // pairs flatten to plain ids on the wire (§9.1) — the variant is a
      // runtime notion, models have no serializable names
      if (def.cardinality === "one") {
        const entry = (relRead(internal, name) as RelationEntry | null) ?? null;

        out[key] = entry === null ? null : entryIdOf(entry);
      } else {
        out[key] = manyIds(internal, name);
      }
      continue;
    }

    // children serialize inline through the child's own bindings (§9.1);
    // a union child embeds its variant's json — `by` re-discriminates on load
    if (def.cardinality === "many") {
      out[key] = manyEntries(internal, name)
        .map((entry) => resolveRelationEntry(state, def, entry))
        .filter((child): child is object => child !== null)
        .map((child) => (child as { json(): unknown }).json());
    } else {
      const child = resolveRelationEntry(state, def, (relRead(internal, name) as RelationEntry | null) ?? null);

      out[key] = child === null ? null : (child as { json(): unknown }).json();
    }
  }
  // inverse views never serialize (§5.3)
}

function applyRelationInput(
  state: CollectionState,
  internal: InstanceInternal,
  input: Record<string, unknown>,
  replace: boolean,
): void {
  for (const [name, runtime] of state.definition.relations) {
    const def = runtime.def;
    const key = def.wireKey ?? name;
    const present = key in input;

    if (!present && !replace) continue;

    const view = internal.relationView!(name) as Record<string, unknown>;

    if (def.relation === "refs" && def.cardinality === "one") {
      const raw = present ? (input[key] as string | null) : null;

      // a wire id stores as-is — for a union target it is the unresolved form,
      // and the target thunk is NOT run here (§5.4 laziness)
      setOneRelation(state, internal, name, def, raw === null || raw === undefined ? null : idOf(raw));
      continue;
    }

    if (def.relation === "refs" && def.cardinality === "many") {
      const rawIds = present ? (input[key] as unknown[]).map((raw) => idOf(raw)!) : [];
      const current = manyEntries(internal, name);
      const keep = new Map<string, RelationEntry>();

      for (const entry of current) keep.set(entryIdOf(entry), entry);

      // the wire order is authoritative; already-resolved pairs keep their
      // variant, fresh ids store unresolved and resolve at first navigation
      const nextEntries: RelationEntry[] = [];
      const seen = new Set<string>();

      for (const id of rawIds) {
        if (seen.has(id)) continue;

        seen.add(id);
        nextEntries.push(keep.get(id) ?? id);
      }

      for (const entry of current) {
        if (!seen.has(entryIdOf(entry))) reverseDrop(state, name, entryIdOf(entry), internal.id);
      }

      for (const id of seen) reverseAdd(state, name, id, internal.id);

      relWrite(internal, name, nextEntries);
      continue;
    }

    if (def.relation === "children" && def.cardinality === "many") {
      // §3.1: a present children array is authoritative — per-child upsert PLUS
      // reconciliation; absent children are disposed; array order is the order.
      // The target's own add handles known-id merges and creation — for a
      // union target that includes `by` routing (§5.2).
      const jsons = present ? (input[key] as Record<string, unknown>[]) : [];
      const target = targetCollectionOf(state, def);
      const current = manyEntries(internal, name);
      const nextEntries: RelationEntry[] = [];

      for (const json of jsons) {
        creatingViaParent += 1;

        let child: object;

        try {
          child = target.add(json) as object;
        } finally {
          creatingViaParent -= 1;
        }

        const entry = childEntryOf(def, child);

        reverseAdd(state, name, entryIdOf(entry), internal.id);
        nextEntries.push(entry);
      }

      for (const entry of current) {
        if (!nextEntries.some((next) => entryMatchesLoose(entry, next))) {
          reverseDrop(state, name, entryIdOf(entry), internal.id);
          removeChildEntry(state, def, entry);
        }
      }

      relWrite(internal, name, nextEntries);
      continue;
    }

    // children.one (§3.1): same id merges, different/absent replaces, null clears.
    const json = present ? (input[key] as Record<string, unknown> | null) : null;
    const clear = view.clear as () => void;

    if (json === null) {
      clear();
      continue;
    }

    const currentEntry = (relRead(internal, name) as RelationEntry | null) ?? null;
    const suppliedId = typeof json.id === "string" ? json.id : undefined;

    if (suppliedId !== undefined && currentEntry !== null && entryIdOf(currentEntry) === suppliedId) {
      const target = targetCollectionOf(state, def);

      creatingViaParent += 1;

      try {
        target.add(json);
      } finally {
        creatingViaParent -= 1;
      }
    } else {
      clear();
      (view.create as (json: Record<string, unknown>) => void)(json);
    }
  }
}

// Delete policies (§5.1): before a target instance dies, every refs relation in
// the scope pointing at it applies its policy — restrict aborts, nullify clears,
// orphan leaves the id to resolve as null.
function applyDeletePolicies(state: CollectionState, dying: InstanceInternal): void {
  const scopeStates = statesByScope.get(state.scope);

  if (!scopeStates) return;

  const probe: RelationEntry = { model: state.definition, id: dying.id };

  for (const other of scopeStates) {
    for (const [name, runtime] of other.definition.relations) {
      const def = runtime.def;

      if (def.relation !== "refs") continue;

      // Links are created by WRITES, not navigation — the reverse bucket is the
      // truth; the target resolves here (cheap, and all modules exist by now).
      const bucket = reverseOf(other, name).get(dying.id);

      if (!bucket || bucket.size === 0) continue;
      if (!relationTargetsModel(def, state.definition)) continue;

      // Union targets key reverse buckets by id alone — narrow to owners whose
      // STORED entry references the dying variant; a same-id instance of
      // another variant must be untouched (§5.2).
      const needsEntryCheck = relationIsUnion(def);
      const referencing: InstanceInternal[] = [];

      for (const ownerId of [...bucket]) {
        const owner = other.instances.get(ownerId);

        if (!owner) continue;

        if (!needsEntryCheck) {
          referencing.push(owner);
          continue;
        }

        const current = relRead(owner, name);
        const matches = Array.isArray(current)
          ? (current as RelationEntry[]).some((entry) => entryMatchesLoose(entry, probe))
          : current !== null &&
            current !== undefined &&
            entryMatchesLoose(current as RelationEntry, probe);

        if (matches) referencing.push(owner);
      }

      if (referencing.length === 0) continue;

      const policy = def.onDelete ?? "nullify";

      if (policy === "restrict") {
        throw new Error(
          `[models] restrict: instance "${dying.id}" is still referenced through relation "${name}" (§5.1)`,
        );
      }

      if (policy === "nullify") {
        for (const owner of referencing) {
          if (def.cardinality === "one") {
            setOneRelation(other, owner, name, def, null);
          } else {
            removeFromMany(other, owner, name, probe);
          }
        }
      }
      // orphan: leave ids in place — reads resolve to null (§5.1)
    }
  }
}

function cascadeChildren(state: CollectionState, dying: InstanceInternal): void {
  for (const [name, runtime] of state.definition.relations) {
    const def = runtime.def;

    if (def.relation !== "children") continue;

    const entries =
      def.cardinality === "many"
        ? manyEntries(dying, name)
        : [(relRead(dying, name) as RelationEntry | null) ?? null].filter(
            (entry): entry is RelationEntry => entry !== null,
          );

    for (const entry of entries) {
      reverseDrop(state, name, entryIdOf(entry), dying.id);
      removeChildEntry(state, def, entry);
    }
  }
}

function rewriteRelationIds(state: CollectionState, oldId: string, newId: string): void {
  const scopeStates = statesByScope.get(state.scope);

  if (!scopeStates) return;

  // §10.1: rebind rewrites every fk pointing at the instance, via reverse indexes.
  for (const other of scopeStates) {
    for (const [name, runtime] of other.definition.relations) {
      const def = runtime.def;
      const reverse = reverseOf(other, name);
      const bucket = reverse.get(oldId);

      if (!bucket) continue;
      // Two models may share an id string — only rewrite fks that actually
      // target the rebound instance's model.
      if (!relationTargetsModel(def, state.definition)) continue;

      if (!relationIsUnion(def)) {
        // model target: every id in this bucket is unambiguously the model's
        reverse.delete(oldId);
        reverse.set(newId, bucket);

        for (const ownerId of bucket) {
          const owner = other.instances.get(ownerId);

          if (!owner) continue;

          const current = relRead(owner, name);

          if (Array.isArray(current)) {
            relWrite(owner, name, current.map((id) => (id === oldId ? newId : id)));
          } else if (current === oldId) {
            relWrite(owner, name, newId);
          }
        }
        continue;
      }

      // union target: surgical — rewrite only entries referencing THIS variant;
      // a same-id entry of another variant keeps its id and its bucket slot
      const probe: RelationEntry = { model: state.definition, id: oldId };
      const rewritten: RelationEntry = { model: state.definition, id: newId };

      for (const ownerId of [...bucket]) {
        const owner = other.instances.get(ownerId);

        if (!owner) continue;

        const current = relRead(owner, name);
        let touched = false;

        if (Array.isArray(current)) {
          const next = (current as RelationEntry[]).map((entry) => {
            if (!entryMatchesLoose(entry, probe)) return entry;

            touched = true;

            return rewritten;
          });

          if (touched) relWrite(owner, name, next);
        } else if (
          current !== null &&
          current !== undefined &&
          entryMatchesLoose(current as RelationEntry, probe)
        ) {
          touched = true;
          relWrite(owner, name, rewritten);
        }

        if (touched) {
          bucket.delete(ownerId);
          reverseAdd(other, name, newId, ownerId);
        }
      }

      if (bucket.size === 0) reverse.delete(oldId);
    }
  }
}

// ---------------------------------------------------------------------------
// Binding seams (§10.1) and inspector aggregation (§10.3).

export function isModelQuery(value: unknown): value is Query {
  return (
    typeof value === "object" && value !== null && (value as Query)["~query"] === true
  );
}

/** What a subscription-based binding needs to follow a query: the epoch stores
 * whose bumps can change the result (one per participating collection). */
export function queryReactivity(query: object): {
  scope: Scope;
  versions: StoreWritable<number>[];
} {
  const marked = query as Query;

  if (marked["~query"] !== true || !marked["~versions"] || !marked["~scope"]) {
    throw new Error("[models] queryReactivity expects a collection query (§10.1)");
  }

  return { scope: marked["~scope"], versions: marked["~versions"]() };
}

/** Per-instance change feed for bindings: own field/relation writes, dispose,
 * rebind. Granularity is the instance — exactly what an entity view renders. */
export function subscribeInstance(instance: object, listener: () => void): () => void {
  const internal = instanceInternalOf(instance);

  if (!internal) {
    throw new Error("[models] subscribeInstance expects a model instance (§10.1)");
  }

  return internal.subscribeSelf ? internal.subscribeSelf(listener) : () => {};
}

// §10.3: devtools must not see a thousand instance scopes — events attribute to
// the application scope; everything that is not a model instance scope passes
// through untouched.
setInspectorScopeAlias((scope) => {
  const unwrapped = unwrapMicroScope(scope);

  if (!instanceOfScope(unwrapped)) return scope;

  return normalizeHomeScope(unwrapped);
});

export interface CollectionInspectorStats {
  model: string | null;
  kind: "static" | "dynamic";
  count: number;
  indexes: { field: string; kind: "eq" | "ord"; size: number }[];
  plans: number;
  pooledScopes: number;
}

/** Aggregated per-collection view for the inspector (§10.3): entity counts,
 * index statistics, interned plans, pool depth — instead of per-scope noise. */
export function modelsInspectorSnapshot(scope: Scope): CollectionInspectorStats[] {
  const states = statesByScope.get(normalizeHomeScope(scope));

  if (!states) return [];

  return [...states].map((state) => ({
    model: state.definition.name ?? null,
    kind: state.definition.kind,
    count: state.instances.size,
    indexes: [
      ...[...state.indexes.entries()].map(([field, buckets]) => ({
        field,
        kind: "eq" as const,
        size: buckets.size,
      })),
      ...[...state.ordIndexes.entries()].map(([field, ord]) => ({
        field,
        kind: "ord" as const,
        size: ord.byId.size,
      })),
    ],
    plans: state.plans.size,
    pooledScopes: state.freeScopes.length,
  }));
}

function readField(facade: object, field: string): unknown {
  return (facade as Record<string, { value: unknown }>)[field].value;
}

function matches(facade: object, predicate: DescriptorPredicate): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const value = readField(facade, predicate.field) as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const expected = predicate.value as any;

  switch (predicate.op) {
    case "eq":
      return indexKeyOf(value) === indexKeyOf(expected);
    case "neq":
      return indexKeyOf(value) !== indexKeyOf(expected);
    case "gt":
      return value > expected;
    case "gte":
      return value >= expected;
    case "lt":
      return value < expected;
    case "lte":
      return value <= expected;
    case "between":
      return value >= expected && value <= (predicate.upper as never);
    case "startsWith":
      return typeof value === "string" && value.startsWith(String(expected));
    case "includes":
      return Array.isArray(value)
        ? value.includes(expected)
        : typeof value === "string" && value.includes(String(expected));
  }
}
