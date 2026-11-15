import { dynamicInstantiation, dynamicInitialization } from "./dynamic-runtime";
export { isModelQuery, queryReactivity, subscribeInstance } from "./protocol";
import { trackNode, isTracking } from "../graph/deps";
import { owner, withOwner, withoutOwner, type Owner } from "../graph/owner";
import { setInspectorScopeAlias, isInspectorEnabled, devDiagnostics } from "../kernel/inspector";
import { activeTransactionDepth, beginUpdateEpoch, withTransaction } from "../kernel/transaction";
import { requireActiveScope, runScopeTask } from "../scope/internal";
import { unwrapMicroScope } from "../scope/micro";
import type { Scope } from "../scope/types";
import {
  seedScopeStoreValue,
  seedModelStoreValue,
  snapshotStoreOf,
  updateScopeStoreValue,
  nativeStoreStateOf,
  type NativeStoreState,
  store,
} from "../units/store";
import type { StoreWritable } from "../units/store";
import { Value } from "@sinclair/typebox/value";
import { Kind, type TSchema } from "@sinclair/typebox";
import { TypeSystemPolicy } from "@sinclair/typebox/system";
import {
  createInstanceFacade,
  createInstanceScope,
  generateId,
  instanceInternalOf,
  instanceOfScope,
  modelRuntimeOf,
  readRelationStore,
  relationStoreFor,
  runInInstanceContext,
  runInstanceDisposers,
  setBroadcastResolver,
  taskOwnerOf,
  beforeDisposeInstance,
  addDisposalParticipant,
  removeDisposalParticipant,
  adoptInstanceChild,
  getInstanceData,
  setInstanceData,
  deleteInstanceData,
  disposeInstanceForBinding,
  instanceFacadePlanOf,
} from "./definition";
import type {
  DescriptorPredicate,
  DescriptorSort,
  FieldRuntime,
  InstanceInternal,
  ModelDefinition,
  InstanceFacadePlan,
  RelationRuntime,
} from "./definition";
import { bulkRemoval } from "./bulk-removal";
import { fieldIn } from "./fields";
import { isUnionTargetLike, resolveInverseOwning, resolveRelationTarget } from "./relations";
import type { RelationDef, UnionTargetLike } from "./relations";
import type { AnyModel, AnyUnionTyped, TypedCollection, TypedUnionCollection } from "./types";
import { sequenceBinding, type SequenceBinding, type SequenceOperation } from "../sequence";
import {
  modelDefaultCreator,
  modelViewSnapshotOf,
  type ModelBindingData,
  type ModelDisposalTrace,
  type ModelDisposalParticipant,
} from "./bindings";
import { reaction } from "../graph/reaction";
import { withUnitDeclarationTracker } from "../graph/declaration";
import { queueLater, whenScopeIdle } from "../scope/tasks";
import { readRegistry, registryStore, type RegistryStore } from "./registry";
import {
  registerModelSnapshotScope,
  releaseModelSnapshotScope,
  registerModelSnapshotIdentity,
  releaseModelSnapshotIdentity,
  restoredModelIdentity,
  withSidScope,
  releaseModelSnapshotNamespace,
  forgetPooledModelScope,
  withStoreDeclarationTracker,
  releaseStoreDeclaration,
  deferModelSnapshots,
  deferModelNamespace,
  hasPendingSnapshot,
  flushModelSnapshots,
  type SnapshotStore,
  type ModelScopeBinding,
  type DeferredModelNamespace,
} from "../scope/snapshot";
import { retainShapes } from "../kernel/shapes";
import { disposeScopeEdges } from "../kernel/scoped-edges";

// A model owns one registry store. Its value (instances, indexes and query
// caches) is local to the application scope; no parallel per-scope map exists.
const registries = new WeakMap<ModelDefinition, RegistryStore<Collection>>();

function registryOf(definition: ModelDefinition): RegistryStore<Collection> {
  let registry = registries.get(definition);
  if (!registry) {
    registry = registryStore<Collection>();
    registries.set(definition, registry);
  }
  return registry;
}

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
  const registry = registries.get(definition);
  const home = registry && readRegistry(registry, scope);

  if (!home || home.scope !== scope) return [];

  const state = (home as unknown as { "~state": CollectionState })["~state"];

  return [...state.rows.values()];
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
  remove(id?: string): void | Promise<void>;
  where(predicate: DescriptorPredicate | ((instance: Instance) => boolean)): Query<Instance>;
  sort(by: DescriptorSort): Query<Instance>;
  take(count: number): Query<Instance>;
}

export interface Query<Instance extends object = object> extends Iterable<Instance> {
  readonly [sequenceBinding]?: SequenceBinding<Instance>;
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
  remove(id?: string): void | Promise<void>;
  toArray(): Instance[];
}

export interface CollectionState {
  model: ModelDefinition;
  runtime: ModelDefinition;
  facade?: InstanceFacadePlan;
  snapshots: ReadonlyMap<string, SnapshotStore>;
  /** The model SID or name; instances of an anonymous model have no snapshot identity. */
  readonly type: string | undefined;
  /**
   * New instances skip snapshot registration until the root's first snapshot
   * reader registers them all (`deferModelSnapshots`); undefined before the
   * first instance decides.
   */
  snapshotDeferred: boolean | undefined;
  /** The root's snapshot state while deferring. */
  snapshot: object | undefined;
  /**
   * Deferred instances allocated but not yet in `instances` (a dynamic setup
   * is running), in allocation order: a flush there must register them too.
   */
  allocating: InstanceInternal[] | undefined;
  flushDeferredSnapshots(namespaces: DeferredModelNamespace[]): void;
  scope: Scope;
  rows: Map<string, InstanceInternal>;
  /** oldId → newId, alive while the rebound instance is alive (§10.1). */
  aliases: Map<string, string>;
  /** field → value → ids (eq hash indexes, §7.3). */
  indexes: Map<string, Map<unknown, Set<string>>>;
  /**
   * The eq indexes' buckets as a list, fixed at creation. An instance keeps its
   * key in each at the same position (`InstanceInternal.indexKeys`), so a write
   * moves it between buckets without a reverse lookup.
   */
  buckets: Map<unknown, Set<string>>[];
  /** field → position in `buckets`. */
  slots: Map<string, number>;
  /** field → ord index: id → key, sorted view rebuilt lazily on first query (§7.3). */
  ordered: Map<string, OrdIndex>;
  /**
   * Instances in insertion order (a rebind keeps the position). A removed one
   * leaves an `undefined` hole that later compaction drops, so removing many
   * instances stays linear.
   */
  order: (InstanceInternal | undefined)[];
  /** Holes in `order`, and the index before which every slot is a hole. */
  holes: number;
  head: number;
  next: number;
  /** relation → targetId → owner ids. Structural (§7.1): maintained eagerly. */
  reverse: Map<string, Map<string, Set<string>>>;
  /** membership/write epoch: reactive terminals read it, mutations bump it (§8). */
  version: StoreWritable<number>;
  /** interned query plans: shape → record with a single-slot (values, result) memo (§8). */
  plans: Map<string, PlanRecord>;
  /** §3.5: recycled static slots and their scopes, if materialized. The slot
   * stays, generation increases; bounded so churn-then-idle does not pin memory. */
  pool: { scope: Scope | undefined; slot: number; generation: number }[];
  /** What `validateAddInput` checks, resolved on first use. */
  input: InputPlan | undefined;
  /** Reservations include scopes waiting for unit tasks; the pool stays bounded
   * before the recycling microtasks run, not only after they have drained. */
  recycling: number;
  changes: Set<CollectionListener>;
  /** Changes held back while a bulk removal runs; delivered together after it. */
  held?: CollectionChange[];
  /** Native epoch state belongs to this already scope-local registry. */
  readonly epoch: CollectionEpoch;
}

interface OrdIndex {
  byId: Map<string, unknown>;
  /** null — dirty; rebuilt on first range/sort access after a change. */
  sorted: { ids: string[]; keys: unknown[] } | null;
}

interface CollectionChange {
  kind: "insert" | "remove" | "update";
  row: InstanceInternal;
  /** A rebind can resolve previously missing IDs; field writes cannot. */
  oldId?: string;
}

type CollectionListener = ((change: CollectionChange) => void) & {
  /** Optional: one bulk operation's changes at once, in order. */
  batch?: (changes: readonly CollectionChange[]) => void;
};

interface CollectionEpoch {
  value: number;
  exposed: boolean;
  unit: StoreWritable<number>;
}

interface PlanRecord {
  epoch: number;
  values: unknown[] | null;
  rows: InstanceInternal[];
  ids: string[];
  items: object[] | null;
}

// Every collection of a scope, for delete policies and rebind fk rewriting.
const registryStates = registryStore<{ scope: Scope; states: Set<CollectionState> }>();

function statesOfScope(scope: Scope): Set<CollectionState> | undefined {
  const registry = readRegistry(registryStates, scope);
  return registry?.scope === scope ? registry.states : undefined;
}
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
  const scope = normalizeHomeScope(explicitScope ?? requireActiveScope(modelScopeDescription));

  if ((modelRuntimeOf(definition) as { "~union"?: unknown })["~union"] === true) {
    if (!unionCollectionFactory) {
      throw new Error("[models] union support is not initialized — import from @virentia/core/models");
    }

    return unionCollectionFactory(definition, scope);
  }

  return modelCollectionInScope(definition, scope);
}

const modelScopeDescription = () => "access model instances";
/** Native definitions already know they are not a union. */
export function modelCollection(definition: ModelDefinition, explicitScope?: Scope): Collection {
  return modelCollectionInScope(
    definition,
    normalizeHomeScope(explicitScope ?? requireActiveScope(modelScopeDescription)),
  );
}

function modelCollectionInScope(definition: ModelDefinition, scope: Scope): Collection {
  const registry = registryOf(definition);
  const existing = readRegistry(registry, scope);

  if (existing?.scope === scope) return existing;

  const created = createCollection(definition, scope);

  seedScopeStoreValue(scope, registry.unit, created);

  return created;
}

function createCollection(definition: ModelDefinition, scope: Scope): Collection {
  const epoch: CollectionEpoch = {
    value: 0,
    exposed: false,
    unit: withUnitDeclarationTracker(null, () =>
      withStoreDeclarationTracker(
        () => {},
        () => store<number>(0),
      ),
    ),
  };
  const state = {
    model: definition,
    runtime: modelRuntimeOf(definition),
    facade: instanceFacadePlanOf(modelRuntimeOf(definition)),
    snapshots: snapshotFieldsOf(modelRuntimeOf(definition)),
    type: snapshotType(modelRuntimeOf(definition)),
    snapshotDeferred: undefined,
    snapshot: undefined,
    allocating: undefined,
    flushDeferredSnapshots: flushDeferredInstanceSnapshots,
    scope,
    rows: new Map(),
    aliases: new Map(),
    indexes: new Map(),
    buckets: [],
    slots: new Map(),
    ordered: new Map(),
    order: [],
    holes: 0,
    head: 0,
    next: 0,
    reverse: new Map(),
    plans: new Map(),
    pool: [],
    input: undefined,
    recycling: 0,
    changes: new Set(),
    epoch,
  } as unknown as CollectionState;
  // An accessor in an object literal puts V8's entire registry into dictionary
  // mode. Install one shared descriptor after its data fields instead: every
  // instance reads this registry, not just queries that expose the epoch.
  Object.defineProperty(state, "version", collectionVersionDescriptor());

  for (const name of definition.relations.keys()) {
    state.reverse.set(name, new Map());
  }

  let scopeStates = statesOfScope(scope);

  if (!scopeStates) {
    scopeStates = new Set();
    seedScopeStoreValue(scope, registryStates.unit, { scope, states: scopeStates });
  }

  scopeStates.add(state);

  for (const [name, runtime] of definition.fields) {
    if (runtime.def.indexed === "eq") {
      const buckets = new Map<unknown, Set<string>>();
      state.indexes.set(name, buckets);
      state.slots.set(name, state.buckets.length);
      state.buckets.push(buckets);
    }
    if (runtime.def.indexed === "ord")
      state.ordered.set(name, { byId: new Map(), sorted: null });
  }

  if (definition.kind === "static") subscribeStaticDefinition(definition);

  const facadeOf = (internal: InstanceInternal): object => {
    return (internal.facade ??= createInstanceFacade(internal));
  };

  const query = createQuery(state, facadeOf, []);
  const removeAll = query.remove;
  const self: Collection = Object.assign(query, {
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
        // One batch is one change for listeners: a query appends its new rows
        // at once instead of one operation per instance.
        const holding = state.changes.size > 0 && !state.held;
        if (holding) state.held = [];

        try {
          // Built by push: a preallocated array is holey, and code iterating the
          // returned facades (a removal over them, a map) slows down on it.
          const facades: object[] = [];
          for (let index = 0; index < input.length; index++) {
            const entry = input[index];
            const suppliedId = typeof entry.id === "string" ? entry.id : undefined;
            const existing =
              suppliedId === undefined ? undefined : (state.rows.get(suppliedId) ?? null);
            const facade = addOne(state, facadeOf, entry, options, false, existing);

            if (!existing) created.push(facade);

            facades.push(facade);
          }
          return facades;
        } catch (error) {
          for (const facade of created) {
            (facade as { dispose(): void }).dispose();
          }

          throw error;
        } finally {
          if (holding) deliverHeldChanges(state);
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

      const direct = state.rows.get(id);

      if (direct) return facadeOf(direct);

      // Forwarding is a fallback only — a direct id match always wins (§10.1).
      const forwarded = state.aliases.get(id);
      const viaForwarding = forwarded ? state.rows.get(forwarded) : undefined;

      return viaForwarding ? facadeOf(viaForwarding) : null;
    },

    remove(id?: string) {
      if (id === undefined) return removeAll();
      const internal = state.rows.get(id);

      if (internal) return disposeInstance(state, internal);
    },
  }) as Collection;

  Object.defineProperty(self, modelDefaultCreator, {
    value(id: string, identityInput?: { id: string }) {
      const definition = state.runtime;
      if (
        definition.kind !== "static" ||
        definition["~singletonOf"] ||
        state.indexes.size ||
        state.ordered.size
      )
        return;
      const input = identityInput ?? { id };
      const fields = creationFieldsOf(definition),
        seeds = fieldSeedsOf(definition);
      for (let index = 0; index < fields.length; index++) {
        const field = fields[index];
        if (field.inputKey !== null && (field.inputKey in input || !field.def.defaultValue)) return;
        if (!Object.is(field.def.defaultValue?.value, seeds[index].initial)) return;
      }
      return addOne(state, facadeOf, input, undefined, true);
    },
  });
  return self;
}

let collectionVersionProperty: PropertyDescriptor | undefined;
// The initializer has no collection argument/frame: its cached accessors must
// never retain the first application scope that asks for a registry.
function collectionVersionDescriptor(): PropertyDescriptor {
  return (collectionVersionProperty ??= {
    configurable: true,
    enumerable: true,
    get(this: CollectionState) {
      return exposeVersion(this, this.epoch);
    },
    set(this: CollectionState, unit: StoreWritable<number>) {
      this.epoch.unit = unit;
      this.epoch.exposed = true;
    },
  });
}

const subscribedStaticDefinitions = new WeakSet<ModelDefinition>();
/** Route a shared unit to its own registry without visiting unrelated scopes. */
function subscribeStaticDefinition(definition: ModelDefinition): void {
  if (subscribedStaticDefinitions.has(definition)) return;
  const subscriptions: (() => void)[] = [];
  const subscribe = (name: string, unit: StoreWritable<unknown>): void => {
    // Never capture a collection/application here: the shared definition must
    // not keep abandoned application scopes alive. Values stay per-scope.
    subscriptions.push(
      runScopeTask(null, () =>
        withoutOwner(() =>
          unit.subscribe((value, writeScope) => {
            let internal: InstanceInternal | undefined;
            let current: CollectionState | undefined;
            if (definition["~singletonOf"]) {
              const home = unwrapMicroScope(writeScope);
              const instances = readRegistry(registryOf(definition), home);
              if (instances?.scope !== home) return;
              current = stateOfCollection(instances);
              internal = current.rows.values().next().value;
            } else {
              internal = instanceOfScope(writeScope);
              current = internal?.registry;
              if (current?.model !== definition) return;
            }
            if (internal?.listed) {
              updateIndexes(current, name, internal, value);
              bumpVersion(current);
              emitCollectionChange(current, "update", internal);
            }
          }),
        ),
      ),
    );
  };
  try {
    for (const [name, runtime] of definition.fields) subscribe(name, runtime.staticStore!);
    for (const [name, runtime] of definition.relations) subscribe(name, runtime.staticStore!);
    subscribedStaticDefinitions.add(definition);
  } catch (error) {
    for (const unsubscribe of subscriptions) unsubscribe();
    throw error;
  }
}

// Value-typed keys (Date) normalize to a primitive so eq/index buckets work.
function indexKeyOf(value: unknown): unknown {
  return value instanceof Date ? `~date:${value.getTime()}` : value;
}

export function ordKeyOf(value: unknown): unknown {
  return value instanceof Date ? value.getTime() : value;
}

function bumpVersion(state: CollectionState): void {
  const epoch = state.epoch;
  // The epoch is still authoritative for imperative/LINQ reads. Until a unit
  // escapes or is tracked, publishing an unobserved bookkeeping store adds no
  // information. Transactions and inspection always use the full native path.
  if (!epoch.exposed && !activeTransactionDepth() && !isInspectorEnabled()) {
    epoch.value++;
    beginUpdateEpoch();
    return;
  }
  updateScopeStoreValue(state.scope, exposeVersion(state, epoch), incrementVersion);
}
function exposeVersion(state: CollectionState, epoch: CollectionEpoch): StoreWritable<number> {
  if (!epoch.exposed) {
    seedScopeStoreValue(state.scope, epoch.unit, epoch.value);
    epoch.exposed = true;
  }
  return epoch.unit;
}
function incrementVersion(value: number): number {
  return value + 1;
}

function emitCollectionChange(
  state: CollectionState,
  kind: "insert" | "remove" | "update",
  internal: InstanceInternal,
): void {
  if (!state.changes.size) return;
  if (state.held) {
    state.held.push({ kind, row: internal });
    return;
  }
  for (const listener of [...state.changes]) listener({ kind, row: internal });
}

/** Run a bulk operation; its synchronous changes reach listeners together afterwards. */
function holdCollectionChanges<T>(state: CollectionState, run: () => T): T {
  if (state.held) return run();
  state.held = [];
  try {
    return run();
  } finally {
    deliverHeldChanges(state);
  }
}
/** Ends holding `state`'s changes: listeners receive what was held, together. */
function deliverHeldChanges(state: CollectionState): void {
  const changes = state.held!;
  state.held = undefined;
  if (changes.length)
    for (const listener of [...state.changes]) {
      if (!state.changes.has(listener)) continue;
      if (listener.batch) listener.batch(changes);
      else for (const change of changes) listener(change);
    }
}

/** Identity metadata is needed only on rebind, not on the field-write hot path. */
function emitRebindChange(
  state: CollectionState,
  internal: InstanceInternal,
  previousId: string,
): void {
  if (!state.changes.size) return;
  for (const listener of [...state.changes]) listener({ kind: "update", row: internal, oldId: previousId });
}

// Reactive epoch read: track in the CALLER's collector/micro-scope, read in the
// collection's scope — the same split as field facades (§8).
function readVersion(state: CollectionState): number {
  const epoch = state.epoch;
  if (!epoch.exposed && !isTracking()) return epoch.value;
  const unit = exposeVersion(state, epoch);
  trackNode(unit.node);

  return runScopeTask(state.scope, () => unit.value);
}

function updateIndexes(
  state: CollectionState,
  field: string,
  internal: InstanceInternal,
  value: unknown,
): void {
  moveInIndex(state, field, internal, value);

  const ord = state.ordered.get(field);

  if (ord) {
    ord.byId.set(internal.id, ordKeyOf(value));
    ord.sorted = null;
  }
}

function ordSorted(state: CollectionState, field: string): { ids: string[]; keys: unknown[] } {
  const ord = state.ordered.get(field)!;

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

/** An instance's key in an eq index it has not entered yet. */
const unindexed: unknown = Symbol("unindexed");

function unindexedKeys(count: number): unknown[] {
  const keys: unknown[] = [];
  for (let position = 0; position < count; position++) keys.push(unindexed);
  return keys;
}

function moveInIndex(
  state: CollectionState,
  field: string,
  internal: InstanceInternal,
  next: unknown,
): void {
  const position = state.slots.get(field);

  if (position === undefined) return;
  const index = state.buckets[position];
  const key = indexKeyOf(next);
  let keys = internal.indexKeys;
  if (!keys) keys = internal.indexKeys = unindexedKeys(state.buckets.length);
  const previous = keys[position];
  if (previous !== unindexed) {
    // Map uses SameValueZero: both signed zeros and NaN name one bucket.
    if (previous === key || Object.is(previous, key)) return;
    // Buckets hold ids. No two live instances share one, so the old bucket
    // holds this id; the check only guards against a stale key.
    const old = index.get(previous);
    if (old) {
      old.delete(internal.id);
      if (!old.size) index.delete(previous);
    }
  }
  keys[position] = key;
  let bucket = index.get(key);

  if (!bucket) {
    bucket = new Set();
    index.set(key, bucket);
  }

  bucket.add(internal.id);
}

function dropFromIndexes(state: CollectionState, internal: InstanceInternal): void {
  const keys = internal.indexKeys;
  if (keys) {
    internal.indexKeys = undefined;
    const list = state.buckets;
    for (let position = 0; position < keys.length; position++) {
      const key = keys[position];
      if (key === unindexed) continue;
      const buckets = list[position];
      const bucket = buckets.get(key);
      if (!bucket) continue; // see moveInIndex
      bucket.delete(internal.id);
      if (!bucket.size) buckets.delete(key);
    }
  }

  if (state.ordered.size)
    for (const ord of state.ordered.values()) {
      if (ord.byId.delete(internal.id)) ord.sorted = null;
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
  defaults = false,
  // What a batch already found under the input's string id: null for none.
  found?: InstanceInternal | null,
): object {
  const definition = state.runtime;
  const suppliedId =
    typeof input.id === "string" ? input.id : definition.idFromProps?.call(state.model, input);
  if (suppliedId === "") throw emptyIdError("add()");
  const existing =
    found !== undefined ? (found ?? undefined) : suppliedId ? state.rows.get(suppliedId) : undefined;
  if (!existing && definition["~singletonOf"] && state.rows.size) {
    throw new Error("[models] A static singleton can have only one instance per scope");
  }

  if (!existing && creatingViaParent === 0 && ownedModels.has(state.model)) {
    throw new Error(`[models] ${definition.name ?? "this model"} is owned as children — create it through the parent's relation (.add / .create), not directly (§5.1)`);
  }

  if (suppliedId && state.aliases.has(suppliedId)) {
    // add never consults forwarding — it matches real ids; an input reclaiming a
    // live forwarding key drops that entry with a warning (§10.1).
    // eslint-disable-next-line no-console
    console.warn(`[models] add(): id "${suppliedId}" was a forwarding alias; the alias is dropped`);
    state.aliases.delete(suppliedId);
  }

  if (existing) {
    mergeInstance(state, existing, input, options);

    return facadeOf(existing);
  }

  return facadeOf(createOne(state, input, suppliedId, defaults));
}

const noMissingKeys: readonly string[] = [];
function missingRequiredKeys(
  state: CollectionState,
  input: Record<string, unknown>,
  forCreate: boolean,
): readonly string[] {
  if (!forCreate) return noMissingKeys;
  let missing: string[] | undefined;

  for (const runtime of requiredCreationFieldsOf(state.runtime)) {
    const key = runtime.inputKey!;
    if (!(key in input)) {
      (missing ??= []).push(key);
    }
  }

  return missing ?? noMissingKeys;
}

interface InputPlan {
  /** Input keys a creation requires. */
  readonly required: readonly string[];
  /** Bound fields whose present input value is checked against their schema. */
  readonly checked: readonly CreationField[];
}
function inputPlanOf(definition: ModelDefinition): InputPlan {
  return {
    required: requiredCreationFieldsOf(definition).map((runtime) => runtime.inputKey!),
    checked: creationFieldsOf(definition).filter(
      (runtime) => runtime.inputKey !== null && !runtime.def.binding.in,
    ),
  };
}

export function validateAddInput(
  state: CollectionState,
  input: Record<string, unknown>,
  options?: AddOptions,
): void {
  const suppliedId = typeof input.id === "string" ? input.id : undefined;
  if (suppliedId === "") throw emptyIdError("add()");
  const plan = (state.input ??= inputPlanOf(state.runtime));
  const required = plan.required;
  for (let index = 0; index < required.length; index++) {
    if (required[index] in input) continue;
    const exists = suppliedId !== undefined && state.rows.has(suppliedId);
    const missing = missingRequiredKeys(state, input, !exists || Boolean(options?.replace));

    if (missing.length > 0) {
      throw new Error(`[models] add(): ${exists ? "replacing" : "creating"} ${state.model.name ?? "model"} requires missing keys: ${missing.join(", ")}`);
    }
    break;
  }

  validateInputSchemas(state, input, plan.checked);
}

// §4.8: the wire input is checked against the TypeBox schema of each present
// bound key — the schema describes the STRUCTURAL wire space. A user `.map`
// takes over the whole conversion, wire shape included, so validation is the
// user's too — their key is skipped.
function validateInputSchemas(
  state: CollectionState,
  input: Record<string, unknown>,
  checked: readonly CreationField[],
): void {
  for (let index = 0; index < checked.length; index++) {
    const runtime = checked[index];
    const key = runtime.inputKey!;

    if (!(key in input)) continue;

    const raw = input[key];

    if (raw === null && runtime.def.optionalValue) continue;

    let ok = true;

    try {
      ok = runtime.validate
        ? runtime.validate(runtime.def.schema, raw)
        : Value.Check(runtime.def.schema, raw);
    } catch {
      continue; // uninstantiated generic placeholders etc. — nothing to check
    }

    if (!ok) {
      const [first] = [...Value.Errors(runtime.def.schema, raw)];

      throw new Error(`[models] add(): invalid "${key}" for ${state.model.name ?? "model"}${first ? ` — ${first.message} at ${first.path || "value"}` : ""}`);
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
  defaults = false,
): InstanceInternal {
  const definition = state.runtime;
  let missing: string[] | undefined;
  const fields = creationFieldsOf(definition);
  // Sized up front: a light instance keeps this array as its field seed.
  const values: unknown[] | undefined = defaults ? undefined : new Array(fields.length);

  if (!defaults)
    for (let index = 0; index < fields.length; index++) {
      const runtime = fields[index];
      const key = runtime.inputKey;

      if (key !== null && key in input) {
        values![index] = fieldIn(runtime.def, input[key]);
      } else if (runtime.def.defaultValue) {
        values![index] = runtime.def.defaultValue.value;
      } else if (key !== null) {
        (missing ??= []).push(key);
      } else {
        values![index] = undefined;
      }
    }

  if (missing) {
    throw new Error(`[models] add(): creating ${definition.name ?? "model"} requires missing keys: ${missing.join(", ")}`);
  }

  const internal = allocateInstance(state, suppliedId);
  // The default constructor owns its identity-only input; public add() inputs
  // still receive an independent snapshot.
  internal.props = defaults ? input : { ...input };

  try {
    initializeAllocatedInstance(state, internal, input, fields, values, defaults);
    // One id names one live instance. The id was free at allocation; code a
    // dynamic setup ran may have taken it since. A static instance runs none.
    if (definition.kind !== "static" && state.rows.has(internal.id))
      throw takenIdError(state, "add()", internal.id);
  } catch (error) {
    // Creation registered the instance at allocation and a failure left that
    // registration behind: a deferred one is registered now, as it would be.
    if (internal.snapshotDeferred) flushModelSnapshots(state.snapshot!);
    settleAllocation(state, internal);
    throw error;
  }

  state.rows.set(internal.id, internal);
  internal.listed = true;
  state.order.push(internal);
  settleAllocation(state, internal);

  try {
    if (definition.relations.size) applyRelationInput(state, internal, input, false);
    if (definition.onCreate) initializeCreatedInstance(state, internal);
    if (definition.kind === "dynamic") dynamicInitialization!(internal);
  } catch (error) {
    const report = (cleanupError: unknown) =>
      console.error("[models] Failed to clean up a model after creation:", cleanupError);
    try {
      const pending = disposeInstance(state, internal);
      if (pending) void pending.catch(report);
    } catch (cleanupError) {
      report(cleanupError);
    }
    throw error;
  }
  bumpVersion(state);
  emitCollectionChange(state, "insert", internal);

  return internal;
}

/** Seed a static instance's fields or run a dynamic setup, before listing it. */
function initializeAllocatedInstance(
  state: CollectionState,
  internal: InstanceInternal,
  input: Record<string, unknown>,
  fields: readonly CreationField[],
  values: unknown[] | undefined,
  defaults: boolean,
): void {
  const definition = state.runtime;
  const native = definition.kind === "static";
  const singleton = Boolean(definition["~singletonOf"]);
  if (native) {
    const indexed = state.indexes.size > 0 || state.ordered.size > 0;
    if (internal.fieldSeed === unseeded) {
      // A light instance keeps its creation values until its scope exists.
      const seed = (internal.fieldSeed =
        values ?? fields.map((runtime) => runtime.def.defaultValue?.value));
      if (indexed)
        for (let index = 0; index < fields.length; index++) {
          const name = fields[index].name;
          if (state.indexes.has(name) || state.ordered.has(name))
            updateIndexes(state, name, internal, seed[index]);
        }
    } else if (!defaults || internal.restoreSnapshot) {
      const seeds = fieldSeedsOf(definition);
      for (let index = 0; index < fields.length; index++) {
        const runtime = fields[index],
          name = runtime.name,
          value = defaults ? runtime.def.defaultValue?.value : values![index];

        if (!singleton) {
          if (internal.restoreSnapshot)
            seedModelStoreValue(internal.scope!, runtime.staticStore!, value);
          else if (!Object.is(value, seeds[index].initial))
            internal.scope!.values.set(seeds[index].id, value);
        }
        if (indexed && (state.indexes.has(name) || state.ordered.has(name)))
          updateIndexes(
            state,
            name,
            internal,
            readInitialStaticField(internal, runtime.staticStore!),
          );
      }
    }
  } else initializeDynamicInstance(state, internal, input, fields, values!);

  // Fresh backing per instance — a shared [] default would alias across instances.
  if (native) {
    for (const [name, runtime] of definition.relations) {
      seedModelStoreValue(
        internal.scope ?? state.scope,
        runtime.staticStore!,
        runtime.def.cardinality === "many" ? [] : null,
      );
    }
  }
}

/** An allocated instance is listed or failed: it is no longer being created. */
function settleAllocation(state: CollectionState, internal: InstanceInternal): void {
  const allocating = state.allocating;
  if (!allocating?.length) return;
  const at = allocating.lastIndexOf(internal);
  if (at >= 0) allocating.splice(at, 1);
}

// Keep optional initialization closures off the scalar static-model creation
// frame. A plain instance needs neither a dynamic setup nor an onCreate scope.
function readInitialStaticField(internal: InstanceInternal, unit: StoreWritable<unknown>): unknown {
  return runInInstanceContext(internal, () => unit.value);
}

function initializeDynamicInstance(
  state: CollectionState,
  internal: InstanceInternal,
  input: Record<string, unknown>,
  fields: readonly CreationField[],
  values: unknown[],
): void {
  const { runtime: definition, scope } = state;
  const prefix = internal.snapshotKey!;
  const declarations = (internal.declarations =
    [] as import("../scope/snapshot").StoreDeclaration[]);
  const { stores, ownOwner, ownerRef } = withoutOwner(() =>
    withSidScope(prefix, () =>
      withStoreDeclarationTracker(
        (declaration) => declarations.push(declaration),
        () =>
          withUnitDeclarationTracker(null, () =>
            dynamicInstantiation!(
              definition,
              scope,
              new Map(fields.map((field, index) => [field.name, values[index]])),
              input,
              internal,
            ),
          ),
      ),
    ),
  );

  internal.ownOwner = ownOwner;
  internal.taskOwner = ownerRef;

  for (const { name } of fields) {
    if (state.indexes.has(name) || state.ordered.has(name))
      updateIndexes(
        state,
        name,
        internal,
        runScopeTask(scope, () => stores.get(name)!.value),
      );
  }

  // Dynamic subscriptions are owned by the instance, not its shared definition.
  withOwner(ownerRef, () => {
    const subscribeDynamic = (name: string): void => {
      stores.get(name)!.subscribe((value, writeScope) => {
        if (unwrapMicroScope(writeScope) === scope && internal.alive) {
          updateIndexes(state, name, internal, value);
          bumpVersion(state);
          emitCollectionChange(state, "update", internal);
        }
      });
    };
    for (const name of definition.fields.keys()) subscribeDynamic(name);
    for (const name of definition.relations.keys()) subscribeDynamic(name);
  });
}

function initializeCreatedInstance(state: CollectionState, internal: InstanceInternal): void {
  const definition = state.runtime;
  const instance = createInstanceFacadeCached(state, internal);
  const result = withOwner(taskOwnerOf(internal), () =>
    runInInstanceContext(internal, () =>
      withUnitDeclarationTracker(
        (kind) => {
          throw new Error(`[models] onCreate cannot declare a ${kind}; declare units in setup`);
        },
        () => (definition.onCreate as (self: object) => unknown)(instance),
      ),
    ),
  );
  if (result && typeof (result as PromiseLike<unknown>).then === "function") {
    void Promise.resolve(result).catch(() => {});
    throw new Error("[models] onCreate must be synchronous; start asynchronous work in an effect");
  }
}

interface CreationField extends FieldRuntime {
  readonly inputKey: string | null;
  readonly validate?: (schema: TSchema, value: unknown) => boolean;
}
const creationFields = new WeakMap<ModelDefinition, readonly CreationField[]>();
const requiredCreationFields = new WeakMap<ModelDefinition, readonly CreationField[]>();
function requiredCreationFieldsOf(definition: ModelDefinition): readonly CreationField[] {
  let fields = requiredCreationFields.get(definition);
  if (!fields) {
    fields = creationFieldsOf(definition).filter(
      (field) => field.inputKey !== null && !field.def.defaultValue,
    );
    requiredCreationFields.set(definition, fields);
  }
  return fields;
}
const nativeFieldSeeds = new WeakMap<ModelDefinition, readonly NativeStoreState[]>();
function fieldSeedsOf(definition: ModelDefinition): readonly NativeStoreState[] {
  let seeds = nativeFieldSeeds.get(definition);
  if (!seeds) {
    seeds = creationFieldsOf(definition).map((field) => nativeStoreStateOf(field.staticStore!)!);
    nativeFieldSeeds.set(definition, seeds);
  }
  return seeds;
}
const snapshotFields = new WeakMap<ModelDefinition, ReadonlyMap<string, SnapshotStore>>();
function snapshotFieldsOf(definition: ModelDefinition): ReadonlyMap<string, SnapshotStore> {
  let fields = snapshotFields.get(definition);
  if (!fields) {
    fields = new Map(
      Array.from(definition.fields.values()).flatMap((field) => {
        const snapshot = field.staticStore && snapshotStoreOf(field.staticStore);
        return snapshot ? [[snapshot.sid, snapshot] as const] : [];
      }),
    );
    snapshotFields.set(definition, fields);
  }
  return fields;
}
function creationFieldsOf(definition: ModelDefinition): readonly CreationField[] {
  let fields = creationFields.get(definition);
  if (!fields)
    creationFields.set(
      definition,
      (fields = Array.from(definition.fields.values(), (runtime) => ({
        ...runtime,
        inputKey: boundKeyOf(runtime.name, runtime.def),
        validate: simpleValidator(runtime.def.schema),
      }))),
    );
  return fields;
}

const isStringInput = (schema: TSchema, value: unknown): boolean =>
  schema[Kind] === "String" &&
  schema.minLength === undefined &&
  schema.maxLength === undefined &&
  schema.pattern === undefined &&
  schema.format === undefined
    ? typeof value === "string"
    : Value.Check(schema, value);
const isBooleanInput = (schema: TSchema, value: unknown): boolean =>
  schema[Kind] === "Boolean" ? typeof value === "boolean" : Value.Check(schema, value);
const isNumberInput = (schema: TSchema, value: unknown): boolean =>
  schema[Kind] === "Number" &&
  schema.minimum === undefined &&
  schema.maximum === undefined &&
  schema.exclusiveMinimum === undefined &&
  schema.exclusiveMaximum === undefined &&
  schema.multipleOf === undefined
    ? TypeSystemPolicy.IsNumberLike(value)
    : Value.Check(schema, value);
function simpleValidator(
  schema: TSchema,
): ((schema: TSchema, value: unknown) => boolean) | undefined {
  // Declarations are resolved once. Keep constrained/compound schemas on the
  // full TypeBox path and retain its live numeric policy for primitive fields.
  switch (schema[Kind]) {
    case "Boolean":
      return isBooleanInput;
    case "Number":
      if (
        schema.minimum === undefined &&
        schema.maximum === undefined &&
        schema.exclusiveMinimum === undefined &&
        schema.exclusiveMaximum === undefined &&
        schema.multipleOf === undefined
      )
        return isNumberInput;
      return undefined;
    case "String":
      if (
        schema.minLength === undefined &&
        schema.maxLength === undefined &&
        schema.pattern === undefined &&
        schema.format === undefined
      )
        return isStringInput;
      return undefined;
    default:
      return undefined;
  }
}

let slotCounter = 0;

const FREE_LIST_LIMIT = 1024;

function snapshotType(definition: ModelDefinition): string | undefined {
  return definition.sid ?? definition.name;
}

function snapshotPrefix(definition: ModelDefinition, id: string): string {
  let prefix = snapshotPrefixes.get(definition);
  if (!prefix)
    snapshotPrefixes.set(
      definition,
      (prefix = `instance:${encodeURIComponent(snapshotType(definition) ?? "anonymous")}:`),
    );
  return prefix + encodeURIComponent(id);
}
const snapshotPrefixes = new WeakMap<ModelDefinition, string>();

// Per-instance state is data. The lifetime/query/ownership machinery is shared
// instead of allocating a set of capturing functions for every model handle.
const instanceProtocol = {
  getData(this: InstanceInternal, key: symbol): ModelBindingData | undefined {
    return getInstanceData(this, key);
  },
  setData(this: InstanceInternal, data: ModelBindingData): void {
    setInstanceData(this, data);
  },
  deleteData(this: InstanceInternal, key: symbol): void {
    deleteInstanceData(this, key);
  },
  disposeWithTrace(this: InstanceInternal, trace: ModelDisposalTrace): void | Promise<void> {
    return disposeInstanceForBinding(this, trace);
  },
  onAliveRead(this: InstanceInternal): void {
    readVersion(this.registry!);
  },
  onBeforeRebind(this: InstanceInternal, newId: string): void {
    const state = this.registry!;
    if (typeof newId !== "string" || newId === "") throw emptyIdError("rebind()");
    const holder = state.rows.get(newId);
    if (holder !== undefined && holder !== this && holder.alive)
      throw takenIdError(state, "rebind()", newId);
    // A rebind moves an identity in the manifest; registering everything
    // first lets it move exactly as it would have after eager registration.
    if (this.snapshotDeferred) flushModelSnapshots(state.snapshot!);
  },
  onWrite(this: InstanceInternal, name: string, value: unknown): void {
    moveInIndex(this.registry!, name, this, value);
  },
  onRebind(this: InstanceInternal, oldId: string, newId: string): void {
    const internal = this,
      state = this.registry!,
      scope = state.scope;
    if (!internal.alive) return;
    NativeInstance.preserveSnapshotKey(internal, oldId);
    const type = state.type;
    // A deferred identity registers later under its current id.
    if (type && !internal.snapshotDeferred) {
      releaseModelSnapshotIdentity(scope, type, oldId);
      registerModelSnapshotIdentity(scope, type, newId, false, internal.snapshotKey);
    }
    unlistId(state, oldId);
    listInstance(state, internal);
    state.aliases.set(oldId, newId);
    for (const [aliasId, target] of state.aliases)
      if (target === oldId) state.aliases.set(aliasId, newId);
    const keys = internal.indexKeys;
    if (keys)
      for (let position = 0; position < keys.length; position++) {
        const key = keys[position];
        if (key === unindexed) continue;
        const bucket = state.buckets[position].get(key);
        if (bucket?.delete(oldId)) bucket.add(newId);
      }
    for (const ord of state.ordered.values()) {
      if (!ord.byId.has(oldId)) continue;
      ord.byId.set(newId, ord.byId.get(oldId));
      ord.byId.delete(oldId);
      ord.sorted = null;
    }
    rewriteRelationIds(state, oldId, newId);
    bumpVersion(state);
    internal.notifySelf?.();
    emitRebindChange(state, internal, oldId);
  },
  onDispose(
    this: InstanceInternal,
    instance: InstanceInternal,
    trace?: ModelDisposalTrace,
  ): void | Promise<void> {
    return disposeInstance(this.registry!, instance, trace);
  },
  createOwned(
    this: InstanceInternal,
    target: ModelDefinition,
    props: Record<string, unknown>,
  ): object {
    if (this.disposal) throw new Error("[models] Cannot create children of a disposing model");
    creatingViaParent++;
    try {
      const child = collection(target, this.parentScope).add(props);
      const internal = instanceInternalOf(child)!;
      if (internal.owningInstance && internal.owningInstance !== this)
        throw new Error("[models] Instance already has an owning parent");
      internal.owningInstance = this;
      (this.ownedInstances ??= new Set()).add(internal);
      return child;
    } finally {
      creatingViaParent--;
    }
  },
  relationView(this: InstanceInternal, name: string): object {
    let view = this.relationCache?.get(name);
    if (!view) {
      view = buildRelationView(this.registry!, this, name);
      (this.relationCache ??= new Map()).set(name, view);
    }
    return view;
  },
  notifySelf(this: InstanceInternal): void {
    if (this.selfListeners) for (const listener of [...this.selfListeners]) listener();
  },
  subscribeSelf(this: InstanceInternal, listener: () => void): () => void {
    if (!this.selfListeners?.size) attachSelf(this);
    (this.selfListeners ??= new Set()).add(listener);
    return () => {
      this.selfListeners!.delete(listener);
      if (!this.selfListeners!.size) this.detachSelf?.();
    };
  },
  serializeRelations(this: InstanceInternal, out: Record<string, unknown>): void {
    serializeRelationsOf(this.registry!, this, out);
  },
};

function attachSelf(internal: InstanceInternal): void {
  const definition = internal.definition,
    scope = internal.parentScope;
  const unsubs: Array<() => void> = [];
  const relevant = (writeScope: Scope): boolean =>
    definition["~singletonOf"]
      ? unwrapMicroScope(writeScope) === scope
      : definition.kind === "static"
        ? instanceOfScope(writeScope) === internal
        : unwrapMicroScope(writeScope) === scope && internal.alive;
  withOwner(detachedRoot, () => {
    const subscribe = (unit: StoreWritable<unknown>): void => {
      unsubs.push(
        unit.subscribe((_value, writeScope) => {
          if (relevant(writeScope)) internal.notifySelf!();
        }),
      );
    };
    if (definition.kind === "static") {
      for (const runtime of definition.fields.values())
        subscribe(runtime.staticStore as StoreWritable<unknown>);
      for (const runtime of definition.relations.values())
        subscribe(runtime.staticStore as StoreWritable<unknown>);
    } else for (const unit of internal.ownStores?.values() ?? []) subscribe(unit);
  });
  internal.detachSelf = () => {
    for (const unsubscribe of unsubs) unsubscribe();
    internal.detachSelf = null;
  };
}

let instanceSequence = 0;

class NativeInstance {
  #scope?: Scope;
  #snapshotStores?: ReadonlyMap<string, SnapshotStore>;
  #snapshotKey?: string;
  get snapshotKey(): string {
    return (this.#snapshotKey ??= snapshotPrefix(this.runtimeDefinition, this.id));
  }
  set snapshotKey(key: string) {
    this.#snapshotKey = key;
  }
  facade?: object;
  /** The target of `facade`. */
  facadeTarget?: object;
  get definition(): ModelDefinition {
    return this.registry.model;
  }
  get runtimeDefinition(): ModelDefinition {
    return this.registry.runtime;
  }
  get parentScope(): Scope {
    return this.registry.scope;
  }
  get scope(): Scope | undefined {
    if (this.#scope) return this.#scope;
    if (this.fieldSeed !== undefined) return this.materializeScope(true);
    const definition = this.runtimeDefinition;
    if (definition.kind !== "static" || definition["~singletonOf"]) return undefined;
    const scope = (this.#scope = createInstanceScope(this.parentScope, definition.locals!));
    registerModelSnapshotScope(
      scope,
      this.parentScope,
      "",
      definition.locals!,
      this.registry.snapshots,
      this as unknown as ModelScopeBinding,
    );
    if (!this.alive) releaseModelSnapshotScope(scope);
    return scope;
  }
  static peekScope(internal: InstanceInternal): Scope | undefined {
    return (internal as unknown as NativeInstance).#scope;
  }
  /**
   * A light instance's scope, on first use: its fields move from the seed into
   * the scope, which then binds to the root as allocation would have. A flush
   * of deferred snapshots registers the namespace itself (`register` false).
   */
  materializeScope(register: boolean): Scope {
    const definition = this.runtimeDefinition;
    const scope = (this.#scope = createInstanceScope(this.parentScope, definition.locals!));
    const seed = this.fieldSeed!;
    this.fieldSeed = undefined;
    if (seed !== unseeded) {
      const seeds = fieldSeedsOf(definition);
      for (let index = 0; index < seeds.length; index++)
        if (!Object.is(seed[index], seeds[index].initial)) scope.values.set(seeds[index].id, seed[index]);
    }
    const binding = this as unknown as ModelScopeBinding;
    if (this.snapshotDeferred) deferModelNamespace(this.registry.snapshot!, scope, binding);
    else if (register)
      registerModelSnapshotScope(
        scope,
        this.parentScope,
        this.registry.snapshots.size ? this.snapshotKey : "",
        definition.locals!,
        this.registry.snapshots,
        binding,
      );
    if (!this.alive) releaseModelSnapshotScope(scope);
    return scope;
  }
  static preserveSnapshotKey(internal: InstanceInternal, originalId: string): void {
    const instance = internal as unknown as NativeInstance;
    instance.#snapshotKey ??= snapshotPrefix(instance.runtimeDefinition, originalId);
  }
  insertionOrder: number;
  alive = true;
  fieldSeed: unknown[] | undefined = undefined;
  // Slots an instance fills during its life (creation input, member handles,
  // renderer data, disposal). Declared up front, every instance keeps one
  // hidden class instead of a chain of property additions in varying order.
  props: Record<string, unknown> | undefined = undefined;
  facadeHandles: unknown = undefined;
  firstFacadeHandle: string | undefined = undefined;
  bindingData: ModelBindingData | Map<symbol, ModelBindingData> | undefined = undefined;
  beforeDisposers: InstanceInternal["beforeDisposers"] = undefined;
  taskOwner: Owner | undefined = undefined;
  disposal: DisposalCompletion | undefined = undefined;
  finalizing: boolean | undefined = undefined;
  restoreSnapshot: boolean | undefined = undefined;
  registered: boolean | undefined = undefined;
  snapshotDeferred: boolean | undefined = undefined;
  listed: boolean | undefined = undefined;
  indexKeys: unknown[] | undefined = undefined;
  // Every child row gets an owner, and every row a component creates gets a
  // cleanup: declared, so those rows keep the class they were created with.
  // Relation views, self listeners, owned children and dispose sites
  // (development only) stay lazy: few instances get them, and every instance
  // would pay for the slots.
  owningInstance: InstanceInternal | undefined = undefined;
  disposers: Set<() => void> | undefined = undefined;
  /** Creation rank across collections: deferred namespaces register in this order. */
  readonly snapshotSequence = ++instanceSequence;
  private snapshotReleased: boolean | undefined = undefined;
  private cachedKey: string | undefined = undefined;
  get key(): string {
    return (this.cachedKey ??= `s${this.slot}g${this.generation}`);
  }
  get root(): Scope {
    return this.parentScope;
  }
  get homeScope(): Scope {
    return this.parentScope;
  }
  get identity(): string {
    return this.snapshotKey ?? this.key;
  }
  beforeDispose(callback: () => void | PromiseLike<unknown>): () => void {
    return beforeDisposeInstance(this as unknown as InstanceInternal, callback);
  }
  addDisposalParticipant(participant: ModelDisposalParticipant): void {
    addDisposalParticipant(this as unknown as InstanceInternal, participant);
  }
  removeDisposalParticipant(participant: ModelDisposalParticipant): void {
    removeDisposalParticipant(this as unknown as InstanceInternal, participant);
  }
  adopt(child: object): void {
    adoptInstanceChild(this as unknown as InstanceInternal, child);
  }
  subscribe(listener: () => void): () => void {
    return (this as unknown as InstanceInternal).subscribeSelf!(listener);
  }
  get instance(): object {
    return this;
  }
  get active(): boolean {
    return this.alive && !this.snapshotReleased;
  }
  set active(active: boolean) {
    this.snapshotReleased = !active;
  }
  get prefix(): string {
    return this.snapshotKey;
  }
  get head(): string {
    const slash = this.snapshotKey.indexOf("/");
    return slash < 0 ? this.snapshotKey : this.snapshotKey.slice(0, slash);
  }
  get owns(): ReadonlySet<unknown> {
    return this.runtimeDefinition.locals!;
  }
  get stores(): ReadonlyMap<string, SnapshotStore> {
    return this.#snapshotStores ?? this.registry.snapshots;
  }
  set stores(stores: ReadonlyMap<string, SnapshotStore>) {
    this.#snapshotStores = stores;
  }
  get shared(): boolean {
    return this.#snapshotStores === undefined;
  }
  set shared(_shared: boolean) {
    /* stores assignment already selects a private map. */
  }
  get automatic(): boolean {
    return this.temporaryId;
  }
  set automatic(automatic: boolean) {
    this.temporaryId = automatic;
  }
  registerSnapshotNamespace(): void {
    const scope = this.#scope;
    if (
      scope &&
      registerModelSnapshotScope(
        scope,
        this.parentScope,
        this.snapshotKey,
        this.runtimeDefinition.locals!,
        this.registry.snapshots,
        this as unknown as ModelScopeBinding,
      )
    )
      this.restoreSnapshot = true;
  }
  constructor(
    readonly registry: CollectionState,
    scope: Scope | undefined,
    public id: string,
    readonly slot: number,
    readonly generation: number,
    public temporaryId: boolean,
  ) {
    this.#scope = scope;
    this.insertionOrder = registry.next++;
  }
}
// Instances die with their collection's rows: keep their hidden class (see
// kernel/shapes.ts).
retainShapes(
  "core/models/collection",
  new NativeInstance({ next: 0 } as CollectionState, undefined, "", 0, 0, false),
);
Object.assign(NativeInstance.prototype, instanceProtocol);

function allocateInstance(
  state: CollectionState,
  suppliedId: string | undefined,
): InstanceInternal {
  const { runtime: definition, scope } = state;

  let instanceScope: Scope | undefined;
  let slot: number;
  let generation = 1;
  let light = false;

  if (definition.kind === "static" && !definition["~singletonOf"]) {
    const recycled = state.pool.pop();

    if (recycled) {
      // §3.5: reuse Scope + Map (`clear()` instead of a new one). Values are
      // cleared at REUSE time — a straggler reaction from the previous
      // occupant's last tick saw stale-but-isolated values, never these.
      recycled.scope?.values.clear();
      instanceScope = recycled.scope;
      slot = recycled.slot;
      generation = recycled.generation + 1;
    } else {
      slotCounter += 1;
      slot = slotCounter;
    }
    // Empty static definitions have no local state to seed. Their scope is
    // needed only if a member actually enters the instance context. A light
    // instance creates it on first use (see `lightInstances`).
    if (!instanceScope && definition.locals!.size) {
      light = lightInstances(state);
      if (!light) instanceScope = createInstanceScope(scope, definition.locals!);
    }
  } else {
    slotCounter += 1;
    slot = slotCounter;
  }

  const type = state.type;
  if (type !== undefined && state.snapshotDeferred === undefined) {
    state.snapshot = deferModelSnapshots(
      scope,
      state,
      type,
      // Static instances with SID fields own a namespace (`instance:<type>:<id>`).
      definition.kind === "static" && !definition["~singletonOf"] && state.snapshots.size
        ? snapshotPrefix(definition, "")
        : undefined,
    );
    state.snapshotDeferred ??= false;
  }
  if (state.snapshotDeferred) {
    // No snapshot reader has run in this root (so nothing restores either):
    // the instance registers only when one does.
    const internal = new NativeInstance(
      state,
      instanceScope,
      suppliedId ?? freshId(state),
      slot,
      generation,
      suppliedId === undefined,
    ) as InstanceInternal;
    if (light) internal.fieldSeed = unseeded;
    if (
      deferModelNamespace(
        state.snapshot!,
        instanceScope,
        internal as unknown as ModelScopeBinding,
      )
    ) {
      internal.snapshotDeferred = true;
      (state.allocating ??= []).push(internal);
    } else {
      // The root registers instances as they are created: this one needs its scope now.
      if (light) instanceScope = (internal as unknown as NativeInstance).materializeScope(false);
      registerInstanceSnapshot(state, internal, instanceScope, suppliedId === undefined);
    }
    return internal;
  }
  const restored = type ? restoredModelIdentity(scope, type, suppliedId) : undefined;
  const internal = new NativeInstance(
    state,
    instanceScope,
    suppliedId ?? restored?.id ?? freshId(state),
    slot,
    generation,
    suppliedId === undefined,
  ) as InstanceInternal;

  if (restored?.key !== undefined) internal.snapshotKey = restored.key;
  if (light) {
    internal.fieldSeed = unseeded;
    // Without a snapshot type or SID fields its scope only binds to the root,
    // which `materializeScope` does later; otherwise it registers now.
    if (type !== undefined || state.snapshots.size)
      instanceScope = (internal as unknown as NativeInstance).materializeScope(false);
  }
  registerInstanceSnapshot(state, internal, instanceScope, suppliedId === undefined);

  return internal;
}

/** A field seed placeholder: the instance is light, and its values are not seeded yet. */
const unseeded: unknown[] = [];

/**
 * Instances of a static model without relations start light: their fields stay
 * in a seed array and their scope is created on first use. A root that is
 * restoring a snapshot needs every scope now, to restore into it.
 */
function lightInstances(state: CollectionState): boolean {
  return state.runtime.relations.size === 0 && !hasPendingSnapshot(state.scope);
}

function registerInstanceSnapshot(
  state: CollectionState,
  internal: InstanceInternal,
  instanceScope: Scope | undefined,
  automatic: boolean,
): void {
  if (
    instanceScope &&
    registerModelSnapshotScope(
      instanceScope,
      state.scope,
      state.snapshots.size ? internal.snapshotKey! : "",
      state.runtime.locals!,
      state.snapshots,
      internal as unknown as ModelScopeBinding,
    )
  )
    internal.restoreSnapshot = true;
  if (state.type)
    registerModelSnapshotIdentity(
      state.scope,
      state.type,
      internal.id,
      automatic,
      internal.snapshotKey,
      instanceScope,
    );
}

/** The root's first snapshot reader: register live deferred instances as creation would have. */
function flushDeferredInstanceSnapshots(
  this: CollectionState,
  namespaces: DeferredModelNamespace[],
): void {
  // Creation registered identities as instances were allocated. Deferred
  // instances have not been rebound (a rebind registers everything first), so
  // allocation order is that order — including instances whose dynamic setup
  // is still running, and inner instances it listed first.
  const deferred: InstanceInternal[] = [];
  for (const internal of this.rows.values())
    if (internal.snapshotDeferred) deferred.push(internal);
  if (this.allocating)
    for (const internal of this.allocating) if (internal.snapshotDeferred) deferred.push(internal);
  deferred.sort(byAllocation);
  for (const internal of deferred) {
    internal.snapshotDeferred = false;
    if (!internal.alive) continue;
    const materializing = internal.fieldSeed !== undefined;
    const instanceScope = materializing
      ? (internal as unknown as NativeInstance).materializeScope(false)
      : NativeInstance.peekScope(internal);
    // SID namespaces are registered below for models with declared SID fields.
    // A newly materialized scope without those fields still needs its instance
    // binding: reactions/self and SID stores returned from setup depend on it.
    if (materializing && instanceScope && !this.snapshots.size)
      registerModelSnapshotScope(
        instanceScope,
        this.scope,
        "",
        this.runtime.locals!,
        this.snapshots,
        internal as unknown as ModelScopeBinding,
      );
    registerModelSnapshotIdentity(
      this.scope,
      this.type!,
      internal.id,
      internal.temporaryId,
      internal.snapshotKey,
      instanceScope,
    );
    if (instanceScope && this.snapshots.size)
      namespaces.push(internal as unknown as DeferredModelNamespace);
  }
}

function byAllocation(left: InstanceInternal, right: InstanceInternal): number {
  return (
    (left as unknown as NativeInstance).snapshotSequence -
    (right as unknown as NativeInstance).snapshotSequence
  );
}

function mergeInstance(
  state: CollectionState,
  internal: InstanceInternal,
  input: Record<string, unknown>,
  options?: AddOptions,
): void {
  internal.props = { ...internal.props, ...input };
  const facade = createInstanceFacadeCached(state, internal);

  const writes: Array<[name: string, value: unknown]> = [];
  const missing: string[] = [];

  for (const [name, runtime] of state.model.fields) {
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
    throw new Error(`[models] add(): replacing ${state.model.name ?? "model"} requires missing keys: ${missing.join(", ")}`);
  }

  for (const [name, value] of writes) {
    (facade as Record<string, { value: unknown }>)[name].value = value;
  }

  applyRelationInput(state, internal, input, Boolean(options?.replace));

  // Forwarding entries die with their instance; a merge keeps it alive — nothing to do.
}

function createInstanceFacadeCached(state: CollectionState, internal: InstanceInternal): object {
  return (internal.facade ??= createInstanceFacade(internal));
}

interface RelationLists {
  readonly size: number;
  readonly children: readonly RelationRuntime[];
  readonly refs: readonly RelationRuntime[];
}
const relationLists = new WeakMap<ModelDefinition, RelationLists>();
/** Disposal visits only the relation kinds it acts on, without the public definition proxy. */
function relationListsOf(state: CollectionState): RelationLists {
  const relations = state.runtime.relations;
  let lists = relationLists.get(state.runtime);
  if (!lists || lists.size !== relations.size) {
    const children: RelationRuntime[] = [];
    const refs: RelationRuntime[] = [];
    for (const runtime of relations.values()) {
      if (runtime.def.relation === "children") children.push(runtime);
      else if (runtime.def.relation === "refs") refs.push(runtime);
    }
    relationLists.set(state.runtime, (lists = { size: relations.size, children, refs }));
  }
  return lists;
}

// `listed` mirrors `instances.get(internal.id) === internal` through every map
// change, so a field write checks membership without a lookup. Creation and
// rebind reject an id a live instance holds, so nothing is displaced here; the
// branch below only keeps `listed` exact should an entry ever be replaced.
function listInstance(state: CollectionState, internal: InstanceInternal): void {
  const displaced = state.rows.get(internal.id);
  if (displaced !== undefined) {
    // The map is about to forget a live instance: while it still defers, the
    // root registers first, when every deferred instance can still be found.
    if (displaced.snapshotDeferred) flushModelSnapshots(state.snapshot!);
    displaced.listed = false;
  }
  state.rows.set(internal.id, internal);
  internal.listed = true;
}
/** A generated id no live instance or forwarding alias of this collection holds. */
function freshId(state: CollectionState): string {
  let id = generateId();
  while (state.rows.has(id) || (state.aliases.size && state.aliases.has(id)))
    id = generateId();
  return id;
}
function takenIdError(state: CollectionState, operation: string, id: string): Error {
  return new Error(`[models] ${operation}: id "${id}" is already taken by a live ${state.model.name ?? "model"} instance`);
}
function emptyIdError(operation: string): Error {
  return new Error(`[models] ${operation}: an id must be a non-empty string`);
}
function unlistId(state: CollectionState, id: string): void {
  const listed = state.rows.get(id);
  if (listed === undefined) return;
  listed.listed = false;
  state.rows.delete(id);
}
function unlistInstance(state: CollectionState, internal: InstanceInternal): void {
  if (!internal.listed) return unlistId(state, internal.id);
  internal.listed = false;
  state.rows.delete(internal.id);
}

/** Remove one instance from the insertion order; front and back removals are O(1). */
function dropFromOrder(state: CollectionState, internal: InstanceInternal): void {
  const order = state.order;
  if (order[order.length - 1] === internal) {
    order.pop();
    while (order.length && order[order.length - 1] === undefined) {
      order.pop();
      state.holes--;
    }
    if (state.head > order.length) state.head = order.length;
    return;
  }
  let at = state.head;
  while (at < order.length && order[at] === undefined) at++;
  state.head = at;
  if (order[at] !== internal) at = order.indexOf(internal, at);
  if (at < 0) return;
  order[at] = undefined;
  state.holes++;
  if (state.holes > 32 && state.holes * 2 > order.length) {
    let live = 0;
    for (const entry of order) if (entry !== undefined) order[live++] = entry;
    order.length = live;
    state.holes = 0;
    state.head = 0;
  }
}

function disposalTree(
  state: CollectionState,
  internal: InstanceInternal,
): Array<{ state: CollectionState; internal: InstanceInternal }> {
  // Most scalar/static instances have no ownership edges. Keep the same tree
  // contract without allocating a visitor closure and cycle Set for a leaf.
  if (!relationListsOf(state).children.length && !internal.ownedInstances?.size)
    return [{ state, internal }];
  const result: Array<{ state: CollectionState; internal: InstanceInternal }> = [];
  const seen = new Set<InstanceInternal>();
  const visit = (currentState: CollectionState, current: InstanceInternal) => {
    if (!current.alive || seen.has(current)) return;
    seen.add(current);
    result.push({ state: currentState, internal: current });
    for (const runtime of relationListsOf(currentState).children) {
      const name = runtime.name;
      const value = relRead(current, name);
      const entries = Array.isArray(value) ? value : value == null ? [] : [value];
      for (const entry of entries) {
        const child = resolveRelationEntry(currentState, runtime.def, entry as RelationEntry);
        const target = child && instanceInternalOf(child);
        if (target)
          visit(stateOfCollection(collection(target.definition, target.parentScope)), target);
      }
    }
    for (const child of current.ownedInstances ?? [])
      visit(stateOfCollection(collection(child.definition, child.parentScope)), child);
  };
  visit(state, internal);
  return result;
}

/** A synchronous disposal needs no promise unless a reentrant caller awaits it. */
class DisposalCompletion {
  trace: ModelDisposalTrace | undefined = undefined;
  #promise?: Promise<void>;
  #resolve?: () => void;
  #reject?: (error: unknown) => void;
  #settled = false;
  #error?: AggregateError;
  promise(): Promise<void> {
    if (!this.#promise) {
      this.#promise = new Promise<void>((resolve, reject) => {
        if (this.#settled) {
          if (this.#error) reject(this.#error);
          else resolve();
        } else {
          this.#resolve = resolve;
          this.#reject = reject;
        }
      });
      // Keep rejection observable to callers without leaking an unhandled
      // rejection when disposal is launched by an external renderer.
      void this.#promise.catch(ignoreDisposalRejection);
    }
    return this.#promise;
  }
  settle(error?: AggregateError): void {
    this.#settled = true;
    this.#error = error;
    if (error) this.#reject?.(error);
    else this.#resolve?.();
    this.#resolve = undefined;
    this.#reject = undefined;
  }
}
function ignoreDisposalRejection(): void {}
/** A finished leaf disposal without a trace: rows removed together share it. */
const settledLeafDisposal = new DisposalCompletion();
settledLeafDisposal.settle();

function disposeInstance(
  state: CollectionState,
  internal: InstanceInternal,
  trace?: ModelDisposalTrace,
): void | Promise<void> {
  if (!internal.alive) return;
  if (internal.finalizing) {
    disposeNow(state, internal);
    return;
  }
  if (internal.disposal) return internal.disposal.promise();
  // A leaf with no before-dispose callbacks runs no user code before its own
  // removal: there is nothing to await and no other entry to (re)validate.
  if (
    internal.beforeDisposers === undefined &&
    !relationListsOf(state).children.length &&
    !internal.ownedInstances?.size
  ) {
    applyDeletePolicies(state, internal, true);
    const completion = new DisposalCompletion();
    completion.trace = trace;
    internal.disposal = completion;
    internal.finalizing = true;
    try {
      disposeNow(state, internal);
    } catch (error) {
      internal.disposal = undefined;
      internal.finalizing = false;
      completion.settle(new AggregateError([error], "[models] Disposal failed"));
      return completion.promise();
    }
    completion.settle();
    return;
  }
  const tree = disposalTree(state, internal);
  // Validate the entire cascade before any lifecycle callback or ref mutation.
  for (const entry of tree) applyDeletePolicies(entry.state, entry.internal, true);
  const completion = new DisposalCompletion();
  for (const entry of tree) entry.internal.disposal = completion;
  const pending: Promise<unknown>[] = [];
  const errors: unknown[] = [];
  for (const entry of tree) {
    let callbacks = entry.internal.beforeDisposers;
    // Materialize only when disposing; callbacks registered during this live
    // iteration retain the same Set semantics as multi-observer lifecycles.
    if (callbacks && !(callbacks instanceof Set))
      callbacks = entry.internal.beforeDisposers = new Set([callbacks]);
    for (const callback of callbacks ?? []) {
      try {
        const result = typeof callback === "function" ? callback() : callback.beforeDispose();
        if (result && typeof result.then === "function") pending.push(Promise.resolve(result));
      } catch (error) {
        errors.push(error);
      }
    }
  }
  const finish = () => {
    try {
      // Revalidate after awaited user code; a newly added restrict link cannot
      // silently turn a pending deletion into a partial cascade.
      for (const entry of tree) applyDeletePolicies(entry.state, entry.internal, true);
      for (const entry of tree) entry.internal.finalizing = true;
      // Child nullification can write stores while the cascade is in progress.
      // The dying tree must stop reacting before any child becomes inaccessible;
      // keep its values intact for cleanup callbacks, but drop scoped observers.
      for (const entry of tree) {
        const scope = NativeInstance.peekScope(entry.internal);
        if (scope && scope !== entry.internal.parentScope) disposeScopeEdges(scope);
      }
      disposeNow(state, internal);
    } catch (error) {
      errors.push(error);
      for (const entry of tree) {
        entry.internal.disposal = undefined;
        entry.internal.finalizing = false;
      }
    }
    completion.settle(
      errors.length ? new AggregateError(errors, "[models] Disposal failed") : undefined,
    );
  };
  if (!pending.length) {
    completion.trace = trace;
    finish();
    return errors.length ? completion.promise() : undefined;
  }
  void Promise.allSettled(pending).then((results) => {
    for (const result of results) if (result.status === "rejected") errors.push(result.reason);
    finish();
  });
  return completion.promise();
}

function disposeNow(state: CollectionState, internal: InstanceInternal): void {
  if (!internal.alive) return;

  // restrict must abort BEFORE any state is torn down (§5.1)
  applyDeletePolicies(state, internal);
  cascadeChildren(state, internal);

  // this instance's own outgoing refs release their reverse entries
  for (const runtime of relationListsOf(state).refs) {
    const name = runtime.name;
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

  const trace = internal.disposal?.trace;
  if (trace?.stack !== undefined) internal.disposedSite = trace;
  else if (devDiagnostics) {
    const site = (internal.disposedSite = new Error("dispose site"));
    if (trace) {
      try {
        const stack = site.stack;
        if (typeof stack === "string") {
          trace.stack = stack;
          internal.disposedSite = trace;
        }
      } catch {
        /* Custom stack formatters must not change disposal semantics. */
      }
    }
  }
  internal.alive = false;
  internal.taskOwner?.dispose();
  if (internal.definition.kind === "dynamic") {
    for (const declaration of internal.declarations ?? [])
      releaseStoreDeclaration(internal.parentScope, declaration);
    releaseModelSnapshotNamespace(internal.parentScope, internal.snapshotKey!);
  }
  const instanceScope = NativeInstance.peekScope(internal);
  if (instanceScope) releaseModelSnapshotScope(instanceScope);
  if (internal.snapshotDeferred) internal.snapshotDeferred = false;
  else if (state.type)
    releaseModelSnapshotIdentity(internal.parentScope, state.type, internal.id);
  internal.owningInstance?.ownedInstances?.delete(internal);
  if (internal.beforeDisposers instanceof Set) internal.beforeDisposers.clear();
  internal.beforeDisposers = undefined;
  internal.ownOwner?.dispose();
  if (state.runtime["~singletonOf"]) {
    for (const id of state.model.locals ?? []) state.scope.values.delete(id as symbol);
  }
  // Direct child.dispose() is the same ownership operation as relation.remove.
  // Remove its owning link too, so relation streams never retain a dead row.
  for (const ownerState of statesOfScope(state.scope) ?? []) {
    for (const runtime of relationListsOf(ownerState).children) {
      const name = runtime.name;
      if (!relationTargetsModel(runtime.def, state.model)) continue;
      const bucket = reverseOf(ownerState, name).get(internal.id);
      for (const ownerId of [...(bucket ?? [])]) {
        const parent = ownerState.rows.get(ownerId);
        if (!parent?.alive) continue;
        const probe = { model: state.model, id: internal.id };
        if (runtime.def.cardinality === "many") {
          if (droppedLinks && !relationIsUnion(runtime.def))
            dropLinkLater(droppedLinks, ownerState, parent, name, internal.id);
          else removeFromMany(ownerState, parent, name, probe);
        } else {
          const entry = relRead(parent, name) as RelationEntry | null;
          if (entry && entryMatchesLoose(entry, probe))
            setOneRelation(ownerState, parent, name, runtime.def, null);
        }
      }
    }
  }
  unlistInstance(state, internal);
  internal.facade = undefined;
  if (internal.bindingData !== undefined) {
    if (internal.bindingData instanceof Map) internal.bindingData.clear();
    internal.bindingData = undefined;
  }
  dropFromIndexes(state, internal);

  dropFromOrder(state, internal);

  if (state.aliases.size)
    for (const [oldId, newId] of state.aliases) {
      if (newId === internal.id) state.aliases.delete(oldId);
    }

  bumpVersion(state);
  internal.notifySelf?.();
  emitCollectionChange(state, "remove", internal);
  if (state.runtime.kind === "static" && !state.runtime["~singletonOf"])
    recycleInstanceScope(state, internal, instanceScope);
}

// §3.5: the scope joins the free list a microtask LATER — a same-tick create
// must not reuse a scope whose pending reactions may still drain this tick.
function recycleInstanceScope(
  state: CollectionState,
  internal: InstanceInternal,
  instanceScope: Scope | undefined,
): void {
  if (state.pool.length + state.recycling >= FREE_LIST_LIMIT) return;
  state.recycling++;
  const record = { scope: instanceScope, slot: internal.slot, generation: internal.generation };
  const recycle = () => {
    state.recycling--;
    if (state.pool.length >= FREE_LIST_LIMIT) return;
    // Idle: nothing of the previous occupant runs in it any more (a parked
    // continuation would have kept it busy). Drop what it still references, so
    // a pooled scope does not pin the removed instance and its state until a
    // new instance reuses it.
    if (instanceScope) {
      instanceScope.values.clear();
      forgetPooledModelScope(instanceScope);
      disposeScopeEdges(instanceScope);
    }
    state.pool.push(record);
  };
  if (instanceScope) whenScopeIdle(instanceScope, recycle);
  else queueLater(recycle);
}

/**
 * Rows whose removal runs no user code and touches no other row: a static
 * model no relation in the scope can reach, without lifecycle callbacks,
 * owned work, ownership links or listeners. Nothing can observe the
 * collection between their removals, so its bookkeeping updates once.
 */
function removableAsLeaves(
  state: CollectionState,
  internals: readonly InstanceInternal[],
): boolean {
  const definition = state.runtime;
  if (definition.kind !== "static" || definition["~singletonOf"] || definition.relations.size)
    return false;
  // Every live order entry is listed (no two live instances share an id); a
  // mismatch would mean stale bookkeeping, which the one-by-one path tolerates.
  if (state.order.length - state.holes !== state.rows.size) return false;
  for (const other of statesOfScope(state.scope) ?? []) {
    const lists = relationListsOf(other);
    for (const runtime of lists.refs) {
      // As delete policies do: a refs target is resolved only once a row
      // links to one of the dying ids.
      const reverse = reverseOf(other, runtime.name);
      if (!reverse.size || !internals.some((internal) => reverse.get(internal.id)?.size)) continue;
      if (mayTarget(runtime.def, state.model)) return false;
    }
    for (const runtime of lists.children)
      if (mayTarget(runtime.def, state.model)) return false;
  }
  for (const internal of internals) {
    if (
      !internal.alive ||
      internal.disposal ||
      internal.finalizing ||
      internal.beforeDisposers !== undefined ||
      internal.disposers?.size ||
      internal.taskOwner ||
      internal.ownOwner ||
      internal.ownedInstances?.size ||
      internal.owningInstance ||
      internal.selfListeners?.size
    )
      return false;
  }
  return true;
}

/** A target that fails to resolve may be anything: removal takes the one-by-one path. */
function mayTarget(def: RelationDef, model: ModelDefinition): boolean {
  try {
    return relationTargetsModel(def, model);
  } catch {
    return true;
  }
}

/** `disposeNow` for a batch of leaves (see `removableAsLeaves`). */
function removeLeaves(state: CollectionState, internals: readonly InstanceInternal[]): void {
  // Clearing is exact only when these are every live row: every listed one,
  // and nothing else left in the order.
  let all =
    internals.length === state.rows.size &&
    internals.length === state.order.length - state.holes;
  if (all) for (const internal of internals) all &&= internal.listed === true;
  for (const internal of internals) {
    internal.disposal = settledLeafDisposal;
    internal.finalizing = true;
    if (devDiagnostics) internal.disposedSite = new Error("dispose site");
    internal.alive = false;
    const instanceScope = NativeInstance.peekScope(internal);
    if (instanceScope) releaseModelSnapshotScope(instanceScope);
    if (internal.snapshotDeferred) internal.snapshotDeferred = false;
    else if (state.type)
      releaseModelSnapshotIdentity(internal.parentScope, state.type, internal.id);
    internal.facade = undefined;
    if (internal.bindingData !== undefined) {
      if (internal.bindingData instanceof Map) internal.bindingData.clear();
      internal.bindingData = undefined;
    }
    if (all) {
      internal.listed = false;
      continue;
    }
    unlistInstance(state, internal);
    dropFromIndexes(state, internal);
    dropFromOrder(state, internal);
  }
  if (all) {
    // Every row leaves: the same end state as removing them one by one.
    state.rows.clear();
    for (const internal of internals) internal.indexKeys = undefined;
    for (const buckets of state.buckets) buckets.clear();
    for (const ord of state.ordered.values())
      if (ord.byId.size) {
        ord.byId.clear();
        ord.sorted = null;
      }
    state.order.length = 0;
    state.holes = 0;
    state.head = 0;
    // Forwarding entries die with their target, and every target is leaving.
    state.aliases.clear();
  } else if (state.aliases.size) {
    const removed = new Set<string>();
    for (const internal of internals) removed.add(internal.id);
    for (const [oldId, newId] of state.aliases)
      if (removed.has(newId)) state.aliases.delete(oldId);
  }
  for (const internal of internals) {
    bumpVersion(state);
    emitCollectionChange(state, "remove", internal);
    recycleInstanceScope(state, internal, NativeInstance.peekScope(internal));
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
  sort?: DescriptorSort;
  take?: number;
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

  if (plan.sort) parts.push(`o:${plan.sort.field}:${plan.sort.direction}`);
  if (plan.take !== undefined) {
    parts.push("t");
    values.push(plan.take);
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

/**
 * The insertion order as the instances its ids name now (optionally those in
 * an eq bucket). A listed instance is the one its id names; the map lookup for
 * an unlisted entry only guards against stale bookkeeping.
 */
function resolveOrder(state: CollectionState, bucket?: Set<string>): InstanceInternal[] {
  const internals: InstanceInternal[] = [];
  for (const entry of state.order) {
    if (entry === undefined || (bucket && !bucket.has(entry.id))) continue;
    const internal = entry.listed ? entry : state.rows.get(entry.id);
    if (internal !== undefined) internals.push(internal);
  }
  return internals;
}

/** `idsEqual(ids, internals.map(id))` without building the array. */
function namesIds(internals: readonly InstanceInternal[], ids: readonly string[]): boolean {
  if (internals.length !== ids.length) return false;
  for (let index = 0; index < ids.length; index += 1) {
    if (internals[index].id !== ids[index]) return false;
  }
  return true;
}

function sameInternals(a: readonly InstanceInternal[], b: readonly InstanceInternal[]): boolean {
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }

  return a.length === b.length;
}

function computeInternals(
  state: CollectionState,
  facadeOf: (internal: InstanceInternal) => object,
  plan: QueryPlan,
  sortKeys?: Map<InstanceInternal, unknown>,
): InstanceInternal[] {
  const descriptors = plan.filters.filter(
    (filter): filter is Extract<QueryFilter, { kind: "descriptor" }> =>
      filter.kind === "descriptor",
  );

  // Candidate source: the eq hash first (assumed most selective), then an ord
  // range, then the full membership in insertion order (§7.3).
  let consumed: QueryFilter | null = null;
  let internals: InstanceInternal[] | undefined;
  let ids: readonly string[] | undefined;
  let restoreInsertionOrder = false;

  const eqFilter = descriptors.find(
    (filter) => filter.predicate.op === "eq" && state.indexes.has(filter.predicate.field),
  );

  if (eqFilter) {
    const bucket = state.indexes
      .get(eqFilter.predicate.field)!
      .get(indexKeyOf(eqFilter.predicate.value));

    if (bucket && bucket.size < state.rows.size / 8) {
      ids = [...bucket];
      restoreInsertionOrder = true;
    } else internals = bucket ? resolveOrder(state, bucket) : [];
    consumed = eqFilter;
  } else {
    const rangeFilter = descriptors.find(
      (filter) =>
        RANGE_OPS.has(filter.predicate.op) && state.ordered.has(filter.predicate.field),
    );

    if (rangeFilter) {
      ids = ordRange(state, rangeFilter.predicate);
      consumed = rangeFilter;
    }
  }

  if (ids) {
    internals = [];
    for (const id of ids) {
      const internal = state.rows.get(id);
      if (internal !== undefined) internals.push(internal);
    }
    if (restoreInsertionOrder) internals.sort((a, b) => a.insertionOrder - b.insertionOrder);
  } else internals ??= resolveOrder(state);

  for (const filter of plan.filters) {
    if (filter === consumed) continue;

    internals =
      filter.kind === "scan"
        ? internals.filter((internal) => filter.predicate(facadeOf(internal)))
        : internals.filter((internal) => matches(facadeOf(internal), filter.predicate));
  }

  if (plan.sort) {
    const { field, direction } = plan.sort;
    // Read each reactive key once. A comparator can revisit a row O(log n)
    // times; repeating scoped facade reads there dominates sorting itself.
    const keys = sortKeys ?? new Map<InstanceInternal, unknown>();
    for (const item of internals) keys.set(item, ordKeyOf(readField(facadeOf(item), field)));
    internals.sort((a, b) => {
      const left = keys.get(a);
      const right = keys.get(b);
      const compared = left === right ? 0 : (left as never) < (right as never) ? -1 : 1;

      return direction === "asc" ? compared : -compared;
    });
  }

  if (plan.take !== undefined) {
    internals = internals.slice(0, plan.take);
  }

  return internals;
}

/** An incremental data query: edits name the affected entity, never two lists to match. */
function querySequence(
  state: CollectionState,
  facadeOf: (internal: InstanceInternal) => object,
  plan: QueryPlan,
): SequenceBinding<object> {
  return {
    scope: state.scope,
    snapshot: () =>
      runScopeTask(state.scope, () => computeInternals(state, facadeOf, plan).map(facadeOf)),
    subscribe(listener) {
      const limit = plan.take === undefined ? Infinity : Math.max(0, plan.take);
      // Field changes identify their entity. Keep its current sort key rather
      // than re-reading both reactive facades at every binary-search step.
      const sortKeys = plan.sort ? new Map<InstanceInternal, unknown>() : undefined;
      const ordered = runScopeTask(state.scope, () =>
        computeInternals(state, facadeOf, { ...plan, take: undefined }, sortKeys),
      );
      // A new instance is no member yet: knowing that costs no scan of `ordered`,
      // which made a bulk creation quadratic.
      const members = new Set(ordered);
      const qualifies = (internal: InstanceInternal): boolean =>
        internal.alive &&
        plan.filters.every((filter) =>
          filter.kind === "scan"
            ? filter.predicate(facadeOf(internal))
            : matches(facadeOf(internal), filter.predicate),
        );
      const compare = (left: InstanceInternal, right: InstanceInternal): number => {
        if (plan.sort) {
          const a = sortKeys!.get(left);
          const b = sortKeys!.get(right);
          const value = a === b ? 0 : (a as never) < (b as never) ? -1 : 1;
          if (value) return plan.sort.direction === "asc" ? value : -value;
        }
        return left.insertionOrder - right.insertionOrder;
      };
      const update = (internal: InstanceInternal, removed = false, match?: boolean): void => {
        const from = members.has(internal) ? ordered.indexOf(internal) : -1;
        const include = !removed && (match ?? qualifies(internal));
        if (sortKeys) {
          if (include)
            sortKeys.set(internal, ordKeyOf(readField(facadeOf(internal), plan.sort!.field)));
          else sortKeys.delete(internal);
        }
        if (from < 0 && !include) return;
        // Most field edits do not change membership or rank. Check neighbours
        // before moving an existing row through the ordered array.
        if (
          include &&
          from >= 0 &&
          (from === 0 || compare(ordered[from - 1], internal) <= 0) &&
          (from === ordered.length - 1 || compare(internal, ordered[from + 1]) <= 0)
        )
          return;
        const operations: SequenceOperation<object>[] = [];
        if (!include) {
          ordered.splice(from, 1);
          members.delete(internal);
          if (from < limit) {
            operations.push({ type: "remove", index: from, count: 1 });
            if (ordered.length >= limit)
              operations.push({
                type: "insert",
                index: limit - 1,
                items: [facadeOf(ordered[limit - 1])],
              });
          }
        } else {
          if (from >= 0) ordered.splice(from, 1);
          else members.add(internal);
          let to = ordered.length;
          // Creation appends: only an earlier row needs the search.
          if (to && compare(ordered[to - 1], internal) > 0) {
            let start = 0;
            let end = to;
            while (start < end) {
              const middle = (start + end) >>> 1;
              if (compare(ordered[middle], internal) <= 0) start = middle + 1;
              else end = middle;
            }
            to = start;
          }
          if (to === ordered.length) ordered.push(internal);
          else ordered.splice(to, 0, internal);
          if (from < 0) {
            if (to < limit) {
              operations.push({ type: "insert", index: to, items: [facadeOf(internal)] });
              if (ordered.length > limit)
                operations.push({ type: "remove", index: limit, count: 1 });
            }
          } else if (from !== to) {
            if (from < limit && to < limit) operations.push({ type: "move", from, to, count: 1 });
            else if (from < limit) {
              operations.push({ type: "remove", index: from, count: 1 });
              if (ordered.length >= limit)
                operations.push({
                  type: "insert",
                  index: limit - 1,
                  items: [facadeOf(ordered[limit - 1])],
                });
            } else if (to < limit) {
              operations.push({ type: "insert", index: to, items: [facadeOf(internal)] });
              if (ordered.length > limit)
                operations.push({ type: "remove", index: limit, count: 1 });
            }
          }
        }
        if (operations.length) listener(operations);
      };
      const onChange: CollectionListener = (change) => {
        runScopeTask(state.scope, () => update(change.row, change.kind === "remove"));
      };
      // Unsorted, an instance created later ranks after every member: new rows
      // of a bulk creation go to the end, in creation order.
      const appendCreated = (changes: readonly CollectionChange[]): void => {
        const index = ordered.length;
        const items: object[] = [];
        for (const { row: internal } of changes) {
          if (members.has(internal) || !qualifies(internal)) continue;
          members.add(internal);
          ordered.push(internal);
          items.push(facadeOf(internal));
        }
        if (items.length) listener([{ type: "insert", index, items }]);
      };
      // A bulk creation appends its new rows as one operation; a bulk removal
      // edits the ordered rows in one pass and reports each run of adjacent
      // removed rows as one operation.
      onChange.batch = (changes) => {
        if (
          !sortKeys &&
          limit === Infinity &&
          changes.every((change) => change.kind === "insert")
        ) {
          runScopeTask(state.scope, () => appendCreated(changes));
          return;
        }
        if (limit !== Infinity || changes.some((change) => change.kind !== "remove")) {
          for (const change of changes) onChange(change);
          return;
        }
        const removed = new Set<InstanceInternal>();
        for (const change of changes) removed.add(change.row);
        const operations: SequenceOperation<object>[] = [];
        let kept = 0;
        for (let index = 0; index < ordered.length; ) {
          if (!removed.has(ordered[index])) {
            ordered[kept++] = ordered[index++];
            continue;
          }
          const start = index;
          while (index < ordered.length && removed.has(ordered[index])) {
            sortKeys?.delete(ordered[index]);
            members.delete(ordered[index]);
            index++;
          }
          operations.push({ type: "remove", index: kept, count: index - start });
        }
        ordered.length = kept;
        if (operations.length) listener(operations);
      };
      state.changes.add(onChange);
      // Functional predicates may read application units. Track those reads;
      // entity writes already arrive through the collection's precise feed.
      let initializing = true;
      const watch = plan.filters.some((filter) => filter.kind === "scan")
        ? reaction({
            scope: state.scope,
            run() {
              for (const internal of state.rows.values()) {
                const match = qualifies(internal);
                if (!initializing) update(internal, false, match);
              }
              initializing = false;
            },
          })
        : undefined;
      return () => {
        state.changes.delete(onChange);
        watch?.stop();
        sortKeys?.clear();
        members.clear();
      };
    },
  };
}

function createQuery(
  state: CollectionState,
  facadeOf: (internal: InstanceInternal) => object,
  filters: QueryFilter[],
  sortBy?: DescriptorSort,
  takeCount?: number,
): Query {
  const plan: QueryPlan = { filters, sort: sortBy, take: takeCount };
  const { shape, values } = planShapeOf(plan);

  // Interned by shape; the single-slot memo keys on (values, epoch). Stable
  // identity: an epoch bump that does not change the id sequence keeps the SAME
  // arrays — bindings and React get referential stability for free (§8).
  const resolve = (): PlanRecord => {
    const version = readVersion(state);
    let record = state.plans.get(shape);

    if (record && record.epoch === version && valuesEqual(record.values, values)) {
      return record;
    }

    const internals = computeInternals(state, facadeOf, plan);

    if (record && valuesEqual(record.values, values) && namesIds(internals, record.ids)) {
      record.epoch = version;
      // The same ids can name new instances (removed, then created again); the
      // memo keeps its id array but must not hand out disposed internals.
      if (!sameInternals(record.rows, internals)) {
        record.rows = internals;
        record.items = null;
      }

      return record;
    }

    record = {
      epoch: version,
      values: [...values],
      rows: internals,
      ids: internals.map((internal) => internal.id),
      items: null,
    };
    state.plans.set(shape, record);

    return record;
  };

  const query: Query = {
    [sequenceBinding]: querySequence(state, facadeOf, plan),
    "~query": true as const,
    "~scope": state.scope,
    "~versions": () => [state.version],

    get items() {
      const record = resolve();

      if (!record.items) {
        record.items = record.rows.map(facadeOf);
      }

      return record.items;
    },

    get ids() {
      return resolve().ids;
    },

    get count() {
      return resolve().rows.length;
    },

    get first() {
      const [head] = resolve().rows;

      return head ? facadeOf(head) : null;
    },

    where(predicate) {
      if (typeof predicate !== "function")
        assertOwnDescriptor(state, predicate.model, predicate.field);

      const filter: QueryFilter =
        typeof predicate === "function"
          ? { kind: "scan", predicate }
          : { kind: "descriptor", predicate };

      return createQuery(state, facadeOf, [...plan.filters, filter], plan.sort, plan.take);
    },

    sort(by) {
      assertOwnDescriptor(state, by.model, by.field);

      return createQuery(state, facadeOf, plan.filters, by, plan.take);
    },

    take(count) {
      return createQuery(state, facadeOf, plan.filters, plan.sort, count);
    },

    select(descriptor) {
      return resolve().rows.map((internal) =>
        readField(facadeOf(internal), descriptor.field),
      ) as never;
    },

    set(descriptor, value) {
      for (const internal of resolve().rows) {
        (facadeOf(internal) as Record<string, { value: unknown }>)[descriptor.field].value = value;
      }
    },

    remove() {
      const pending: Promise<void>[] = [];
      bulkRemoval(() =>
        holdCollectionChanges(state, () =>
          // One removal is one update: the collection version, and any store a
          // disposal writes, commits once after the last row instead of per row.
          withTransaction(() => {
            const internals = [...resolve().rows];
            if (internals.length > 1 && removableAsLeaves(state, internals)) {
              removeLeaves(state, internals);
              return;
            }
            withDroppedLinks(() => {
              for (const internal of internals) {
                const result = disposeInstance(state, internal);
                if (result) pending.push(result);
              }
            });
          }),
        ),
      );
      if (pending.length) return Promise.all(pending).then(() => {});
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
  if (model !== undefined && model !== state.model) {
    throw new Error(`[models] descriptor "${field}" belongs to a different model than this collection (§8) — descriptors are taken from the model being queried`);
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

type RelationEntryIndex = Map<string, true | ModelDefinition | Set<ModelDefinition>>;

/** Bare IDs match any variant; concrete union entries match only their model. */
function indexRelationEntries(entries: readonly RelationEntry[]): RelationEntryIndex {
  const index: RelationEntryIndex = new Map();
  for (const entry of entries) {
    if (typeof entry === "string") {
      index.set(entry, true);
      continue;
    }
    const previous = index.get(entry.id);
    if (previous === undefined) index.set(entry.id, entry.model);
    else if (previous instanceof Set) previous.add(entry.model);
    else if (previous !== true && previous !== entry.model)
      index.set(entry.id, new Set([previous, entry.model]));
  }
  return index;
}

function indexedRelationEntry(index: RelationEntryIndex, entry: RelationEntry): boolean {
  if (typeof entry === "string") return index.has(entry);
  const match = index.get(entry.id);
  return (
    match === true || match === entry.model || (match instanceof Set && match.has(entry.model))
  );
}

function relRead(internal: InstanceInternal, name: string): unknown {
  return readRelationStore(internal, name);
}

const relationListeners = new WeakMap<
  InstanceInternal,
  Map<string, Set<(operations: readonly SequenceOperation<object>[]) => void>>
>();

function emitRelation(
  internal: InstanceInternal,
  name: string,
  operations: readonly SequenceOperation<object>[],
): void {
  for (const listener of relationListeners.get(internal)?.get(name) ?? []) listener(operations);
}

function relWrite(
  internal: InstanceInternal,
  name: string,
  value: unknown,
  operations?: readonly SequenceOperation<object>[],
): void {
  runInInstanceContext(internal, () => {
    relationStoreFor(internal, name).value = value;
  });
  if (relationListeners.get(internal)?.get(name)?.size) {
    const view = internal.relationView!(name) as { items?: object[] };
    emitRelation(internal, name, operations ?? [{ type: "reset", items: view.items ?? [] }]);
  }
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
function toWriteEntry(
  state: CollectionState,
  def: RelationDef,
  next: unknown,
): RelationEntry | null {
  if (next === null || next === undefined) return null;
  if (typeof next === "string") {
    const target = resolveRelationEntry(state, def, next);
    if (target && instanceInternalOf(target)?.disposal)
      throw new Error("[models] Cannot link a model while it is being disposed");
    return next;
  }

  const internal = instanceInternalOf(next as object);

  if (!internal) return idOf(next);
  if (internal.disposal) throw new Error("[models] Cannot link a model while it is being disposed");
  if (!internal.alive) throw new Error("[models] Cannot link a disposed model");
  if (internal.parentScope !== state.scope)
    throw new Error("[models] Relation target belongs to a different scope");
  if (!relationIsUnion(def)) return internal.id;

  const target = resolveRelationTarget(def) as UnionTargetLike;

  if (!target.variants.includes(internal.definition)) {
    throw new Error("[models] the instance's model is not a variant of this relation's union target (§5.2)");
  }

  return { model: internal.definition, id: internal.id };
}

function ambiguousUnionId(id: string): Error {
  return new Error(`[models] id "${id}" exists in more than one variant of the union target — an id-only reference cannot disambiguate; write the relation with an instance (§5.2)`);
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

export function stateOfCollection(target: object): CollectionState {
  return (target as unknown as { "~state": CollectionState })["~state"];
}

function reverseOf(state: CollectionState, name: string): Map<string, Set<string>> {
  return state.reverse.get(name)!;
}

function reverseAdd(state: CollectionState, name: string, targetId: string, ownerId: string): void {
  let bucket = reverseOf(state, name).get(targetId);

  if (!bucket) {
    bucket = new Set();
    reverseOf(state, name).set(targetId, bucket);
  }

  bucket.add(ownerId);
}

function reverseDrop(
  state: CollectionState,
  name: string,
  targetId: string,
  ownerId: string,
): void {
  const bucket = reverseOf(state, name).get(targetId);

  if (bucket) {
    bucket.delete(ownerId);

    if (bucket.size === 0) reverseOf(state, name).delete(targetId);
  }
}

function assertUnique(
  state: CollectionState,
  name: string,
  def: RelationDef,
  targetId: string,
  ownerId: string,
): void {
  if (!def.isUnique) return;

  const bucket = reverseOf(state, name).get(targetId);

  if (bucket && (bucket.size > 1 || (bucket.size === 1 && !bucket.has(ownerId)))) {
    throw new Error(`[models] unique constraint: relation "${name}" already links target "${targetId}" to another instance (§5.3)`);
  }
}

function setOneRelation(
  state: CollectionState,
  internal: InstanceInternal,
  name: string,
  def: RelationDef,
  next: RelationEntry | null,
): void {
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

function addToMany(
  state: CollectionState,
  internal: InstanceInternal,
  name: string,
  entry: RelationEntry,
  at?: number,
): void {
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
  const position = at === undefined ? entries.length : at;
  const item = resolveRelationEntry(state, state.model.relations.get(name)!.def, entry);
  relWrite(internal, name, next, [{ type: "insert", index: position, items: [item as object] }]);
  reverseAdd(state, name, entryIdOf(entry), internal.id);
}

/** Removes the first entry matching the probe; returns the REMOVED entry. */
/**
 * Owning links of children a bulk removal disposes, by parent and relation:
 * each relation drops them in one write when the removal ends, instead of a
 * copy of its entries per child.
 */
type DroppedLinks = Map<InstanceInternal, Map<string, Set<string>>>;
let droppedLinks: DroppedLinks | undefined;

function dropLinkLater(
  links: DroppedLinks,
  state: CollectionState,
  parent: InstanceInternal,
  name: string,
  id: string,
): void {
  reverseDrop(state, name, id, parent.id);
  let byName = links.get(parent);
  if (!byName) links.set(parent, (byName = new Map()));
  let ids = byName.get(name);
  if (!ids) byName.set(name, (ids = new Set()));
  ids.add(id);
}

/** Runs a removal of several instances, dropping their owning links together. */
function withDroppedLinks(remove: () => void): void {
  if (droppedLinks) {
    remove();
    return;
  }
  const links: DroppedLinks = (droppedLinks = new Map());
  try {
    remove();
  } finally {
    droppedLinks = undefined;
    for (const [parent, byName] of links) {
      if (!parent.alive) continue;
      for (const [name, ids] of byName) {
        const entries = manyEntries(parent, name);
        const kept: RelationEntry[] = [];
        const operations: SequenceOperation<object>[] = [];
        for (let index = 0; index < entries.length; ) {
          if (!ids.has(entryIdOf(entries[index]))) {
            kept.push(entries[index++]);
            continue;
          }
          const start = index;
          while (index < entries.length && ids.has(entryIdOf(entries[index]))) index++;
          operations.push({ type: "remove", index: kept.length, count: index - start });
        }
        if (operations.length) relWrite(parent, name, kept, operations);
      }
    }
  }
}

function removeFromMany(
  state: CollectionState,
  internal: InstanceInternal,
  name: string,
  probe: RelationEntry,
): RelationEntry | null {
  const entries = manyEntries(internal, name);
  const at = entries.findIndex((current) => entryMatchesLoose(current, probe));

  if (at < 0) return null;

  const removed = entries[at];

  relWrite(
    internal,
    name,
    entries.filter((_, index) => index !== at),
    [{ type: "remove", index: at, count: 1 }],
  );
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

function buildRelationView(
  state: CollectionState,
  internal: InstanceInternal,
  name: string,
): object {
  const inverseRuntime = state.model.inverses.get(name);

  if (inverseRuntime) return buildInverseView(state, internal, inverseRuntime.def);

  const runtime = state.model.relations.get(name)!;
  const def = runtime.def;
  const target = () => targetCollectionOf(state, def);
  const oneEntry = (): RelationEntry | null =>
    (relRead(internal, name) as RelationEntry | null) ?? null;
  const resolvedItems = (): object[] =>
    manyEntries(internal, name)
      .map((entry) => resolveRelationEntry(state, def, entry))
      .filter((instance): instance is object => instance !== null);
  const edits: SequenceBinding<object> = {
    scope: state.scope,
    snapshot: resolvedItems,
    subscribe(listener) {
      // Keep wire positions, including unresolved refs. The UI sees only the
      // resolved subsequence; indices are translated from each source edit,
      // never by matching two rendered lists.
      let entries = [...manyEntries(internal, name)];
      let present = entries.map((entry) => resolveRelationEntry(state, def, entry));
      // Without an unresolved entry, a wire position is its rendered position.
      const visibleBefore = (index: number) =>
        present.includes(null) ? present.slice(0, index).filter(Boolean).length : index;
      const receive = (operations: readonly SequenceOperation<object>[]) => {
        const nextEntries = manyEntries(internal, name);
        const output: SequenceOperation<object>[] = [];
        for (const operation of operations) {
          if (operation.type === "insert") {
            const index = visibleBefore(operation.index);
            const addedEntries = nextEntries.slice(
              operation.index,
              operation.index + operation.items.length,
            );
            const added = addedEntries.map((entry) => resolveRelationEntry(state, def, entry));
            entries.splice(operation.index, 0, ...addedEntries);
            present.splice(operation.index, 0, ...added);
            const items = added.filter((value): value is object => value !== null);
            if (items.length) output.push({ type: "insert", index, items });
          } else if (operation.type === "remove") {
            const index = visibleBefore(operation.index);
            const removed = present.splice(operation.index, operation.count);
            entries.splice(operation.index, operation.count);
            const count = removed.filter(Boolean).length;
            if (count) output.push({ type: "remove", index, count });
          } else if (operation.type === "move") {
            const from = visibleBefore(operation.from);
            const movedEntries = entries.splice(operation.from, operation.count);
            const moved = present.splice(operation.from, operation.count);
            const to = visibleBefore(operation.to);
            entries.splice(operation.to, 0, ...movedEntries);
            present.splice(operation.to, 0, ...moved);
            const count = moved.filter(Boolean).length;
            if (count && from !== to) output.push({ type: "move", from, to, count });
          } else {
            entries = [...nextEntries];
            present = entries.map((entry) => resolveRelationEntry(state, def, entry));
            output.push({
              type: "reset",
              items: present.filter((value): value is object => value !== null),
            });
          }
        }
        if (output.length) listener(output);
      };
      let byName = relationListeners.get(internal);
      if (!byName) relationListeners.set(internal, (byName = new Map()));
      let listeners = byName.get(name);
      if (!listeners) byName.set(name, (listeners = new Set()));
      listeners.add(receive);
      const targetDefinition = resolveRelationTarget(def);
      const variants = isUnionTargetLike(targetDefinition)
        ? targetDefinition.variants
        : [targetDefinition];
      const targetStates = variants.map((variant) =>
        stateOfCollection(collection(variant, state.scope)),
      );
      const onTarget: CollectionListener = (change: CollectionChange) => {
        // Row bindings already observe their fields. A value-only write
        // cannot change relation membership or resolve a missing reference.
        if (change.kind === "update" && change.oldId === undefined) return;
        entries = [...manyEntries(internal, name)];
        const probe = { model: change.row.definition, id: change.row.id };
        for (let index = 0; index < entries.length; index++) {
          if (!entryMatchesLoose(entries[index], probe)) continue;
          const previous = present[index];
          const current = resolveRelationEntry(state, def, entries[index]);
          if (previous === current) continue;
          const at = visibleBefore(index);
          present[index] = current;
          if (previous) listener([{ type: "remove", index: at, count: 1 }]);
          if (current) listener([{ type: "insert", index: at, items: [current] }]);
        }
      };
      // A bulk creation or removal of targets: one pass over the entries, not one per target.
      onTarget.batch = (changes) => {
        if (changes.every((change) => change.kind === "update" && change.oldId === undefined))
          return;
        entries = [...manyEntries(internal, name)];
        for (let index = 0; index < entries.length; index++) {
          const previous = present[index];
          const current = resolveRelationEntry(state, def, entries[index]);
          if (previous === current) continue;
          const at = visibleBefore(index);
          present[index] = current;
          if (previous) listener([{ type: "remove", index: at, count: 1 }]);
          if (current) listener([{ type: "insert", index: at, items: [current] }]);
        }
      };
      for (const targetState of targetStates) targetState.changes.add(onTarget);
      return () => {
        listeners!.delete(receive);
        if (!listeners!.size) byName!.delete(name);
        for (const targetState of targetStates) targetState.changes.delete(onTarget);
      };
    },
  };

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
      [sequenceBinding]: edits,
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
      [sequenceBinding]: edits,
      add: (input: Record<string, unknown> | readonly Record<string, unknown>[]) =>
        addChildren(state, internal, name, def, input),

      remove: (childRef: unknown) => {
        const probe = toWriteEntry(state, def, childRef);

        if (probe === null) return;

        const entries = manyEntries(internal, name);
        const entry = entries.find((entry) => entryMatchesLoose(entry, probe));
        if (!entry) return;
        const child = resolveRelationEntry(state, def, entry) as {
          dispose(): void | Promise<void>;
        } | null;
        const result = child?.dispose();
        const unlink = () => {
          if (internal.alive) removeFromMany(state, internal, name, probe);
        };
        if (result) return result.then(unlink);
        unlink();
      },

      move: (childRef: unknown, index: number) => {
        const probe = toWriteEntry(state, def, childRef);

        if (probe === null) return;

        const entries = manyEntries(internal, name);
        const at = entries.findIndex((current) => entryMatchesLoose(current, probe));

        if (at < 0) return;

        const next = [...entries];
        const [moved] = next.splice(at, 1);
        next.splice(index, 0, moved);
        relWrite(internal, name, next, [{ type: "move", from: at, to: index, count: 1 }]);
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
  const clearOne = (): void | Promise<void> => {
    const current = oneEntry();

    if (current !== null) {
      const child = resolveRelationEntry(state, def, current) as {
        dispose(): void | Promise<void>;
      } | null;
      const result = child?.dispose();
      const unlink = () => {
        if (!internal.alive || oneEntry() !== current) return;
        relWrite(internal, name, null);
        reverseDrop(state, name, entryIdOf(current), internal.id);
      };
      if (result) return result.then(unlink);
      unlink();
    }
  };

  return {
    get value(): object | null {
      return resolveRelationEntry(state, def, oneEntry());
    },

    create: (input: Record<string, unknown>) => {
      const current = oneEntry();

      if (current !== null && resolveRelationEntry(state, def, current) !== null) {
        throw new Error(`[models] children.one "${name}" already has a live child — clear() it explicitly (§5.1)`);
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
  if (!parent.alive || parent.disposal)
    throw new Error("[models] Cannot create a child of a disposing model");
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
      relWrite(
        parent,
        name,
        [...entries, entry],
        [{ type: "insert", index: entries.length, items: [child] }],
      );
    }

    return child;
  };

  if (!Array.isArray(input)) return one(input as Record<string, unknown>);
  // Union variants may share an id: their entries are matched one by one.
  if (relationIsUnion(def)) return input.map(one);
  return addChildBatch(state, parent, name, def, target, input);
}

/**
 * `add` of several children: created by one batch of the target (atomic, and
 * one change for its listeners), recorded in the relation with one write.
 */
function addChildBatch(
  state: CollectionState,
  parent: InstanceInternal,
  name: string,
  def: RelationDef,
  target: Collection,
  inputs: readonly Record<string, unknown>[],
): object[] {
  if (!parent.alive || parent.disposal)
    throw new Error("[models] Cannot create a child of a disposing model");
  let children: object[];
  creatingViaParent += 1;
  try {
    children = target.add(inputs) as object[];
  } finally {
    creatingViaParent -= 1;
  }
  const entries = manyEntries(parent, name);
  const known = new Set(entries.map(entryIdOf));
  const added: RelationEntry[] = [];
  const items: object[] = [];
  for (const child of children) {
    const id = (child as { id: string }).id;
    reverseAdd(state, name, id, parent.id);
    if (known.has(id)) continue;
    known.add(id);
    added.push(childEntryOf(def, child));
    items.push(child);
  }
  if (added.length)
    relWrite(parent, name, [...entries, ...added], [{ type: "insert", index: entries.length, items }]);
  return children;
}

function buildInverseView(
  state: CollectionState,
  internal: InstanceInternal,
  def: import("./relations").InverseDef,
): object {
  const owning = resolveInverseOwning(def);
  const owningRelation = owning.model.relations.get(owning.field);

  if (!owningRelation) {
    throw new Error(`[models] inverse() points at "${owning.field}", which is not a relation of the owning model (§5.3)`);
  }

  const owningDef = owningRelation.def;
  const owningCollection = () =>
    collection(owning.model as ModelDefinition, state.scope) as Collection;
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
      const ownerInternal = owningState.rows.get(ownerId);

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

function serializeRelationsOf(
  state: CollectionState,
  internal: InstanceInternal,
  out: Record<string, unknown>,
): void {
  for (const [name, runtime] of state.model.relations) {
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
        .map(childJson);
    } else {
      const child = resolveRelationEntry(
        state,
        def,
        (relRead(internal, name) as RelationEntry | null) ?? null,
      );

      out[key] = child === null ? null : childJson(child);
    }
  }
  // inverse views never serialize (§5.3)
}

/** A child's `json()`: a native instance serializes without binding the method onto it. */
function childJson(child: object): unknown {
  return modelViewSnapshotOf(child) ?? (child as { json(): unknown }).json();
}

function applyRelationInput(
  state: CollectionState,
  internal: InstanceInternal,
  input: Record<string, unknown>,
  replace: boolean,
): void {
  for (const [name, runtime] of state.model.relations) {
    const def = runtime.def;
    const key = def.wireKey ?? name;
    const present = key in input;

    if (!present && !replace) continue;

    const view = internal.relationView!(name) as Record<string, unknown>;

    if (def.relation === "refs" && def.cardinality === "one") {
      const raw = present ? (input[key] as string | null) : null;

      // a wire id stores as-is — for a union target it is the unresolved form,
      // and the target thunk is NOT run here (§5.4 laziness)
      setOneRelation(
        state,
        internal,
        name,
        def,
        raw === null || raw === undefined ? null : idOf(raw),
      );
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

      // Small lists need no index. Large snapshots must not perform a full
      // linear search for every existing child (quadratic even with no edits).
      const retained =
        current.length > 16 && nextEntries.length > 16
          ? indexRelationEntries(nextEntries)
          : undefined;
      for (const entry of current) {
        const keep = retained
          ? indexedRelationEntry(retained, entry)
          : nextEntries.some((next) => entryMatchesLoose(entry, next));
        if (!keep) {
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

    if (
      suppliedId !== undefined &&
      currentEntry !== null &&
      entryIdOf(currentEntry) === suppliedId
    ) {
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
function applyDeletePolicies(
  state: CollectionState,
  dying: InstanceInternal,
  validateOnly = false,
): void {
  const scopeStates = statesOfScope(state.scope);

  if (!scopeStates) return;

  let probe: RelationEntry | undefined;

  for (const other of scopeStates) {
    for (const runtime of relationListsOf(other).refs) {
      const name = runtime.name;
      const def = runtime.def;

      // Links are created by WRITES, not navigation — the reverse bucket is the
      // truth; the target resolves here (cheap, and all modules exist by now).
      const bucket = reverseOf(other, name).get(dying.id);

      if (!bucket || bucket.size === 0) continue;
      if (!relationTargetsModel(def, state.model)) continue;

      // Union targets key reverse buckets by id alone — narrow to owners whose
      // STORED entry references the dying variant; a same-id instance of
      // another variant must be untouched (§5.2).
      const needsEntryCheck = relationIsUnion(def);
      const referencing: InstanceInternal[] = [];

      for (const ownerId of [...bucket]) {
        const owner = other.rows.get(ownerId);

        if (!owner) continue;

        if (!needsEntryCheck) {
          referencing.push(owner);
          continue;
        }

        const current = relRead(owner, name);
        const matches = Array.isArray(current)
          ? (current as RelationEntry[]).some((entry) =>
              entryMatchesLoose(entry, (probe ??= { model: state.model, id: dying.id })),
            )
          : current !== null &&
            current !== undefined &&
            entryMatchesLoose(
              current as RelationEntry,
              (probe ??= { model: state.model, id: dying.id }),
            );

        if (matches) referencing.push(owner);
      }

      if (referencing.length === 0) continue;

      const policy = def.onDelete ?? "nullify";

      if (policy === "restrict") {
        throw new Error(`[models] restrict: instance "${dying.id}" is still referenced through relation "${name}" (§5.1)`);
      }

      if (policy === "nullify" && !validateOnly) {
        for (const owner of referencing) {
          if (def.cardinality === "one") {
            setOneRelation(other, owner, name, def, null);
          } else {
            removeFromMany(
              other,
              owner,
              name,
              (probe ??= { model: state.model, id: dying.id }),
            );
          }
        }
      }
      // orphan: leave ids in place — reads resolve to null (§5.1)
    }
  }
}

function cascadeChildren(state: CollectionState, dying: InstanceInternal): void {
  for (const runtime of relationListsOf(state).children) {
    const name = runtime.name;
    const def = runtime.def;

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
  if (dying.ownedInstances?.size)
    for (const child of [...dying.ownedInstances]) {
      if (child.alive)
        disposeInstance(stateOfCollection(collection(child.definition, child.parentScope)), child);
    }
}

function rewriteRelationIds(state: CollectionState, oldId: string, newId: string): void {
  const scopeStates = statesOfScope(state.scope);

  if (!scopeStates) return;

  // §10.1: rebind rewrites every fk pointing at the instance, via reverse indexes.
  for (const other of scopeStates) {
    for (const [name, runtime] of other.model.relations) {
      const def = runtime.def;
      const reverse = reverseOf(other, name);
      const bucket = reverse.get(oldId);

      if (!bucket) continue;
      // Two models may share an id string — only rewrite fks that actually
      // target the rebound instance's model.
      if (!relationTargetsModel(def, state.model)) continue;

      if (!relationIsUnion(def)) {
        // model target: every id in this bucket is unambiguously the model's
        reverse.delete(oldId);
        reverse.set(newId, bucket);

        for (const ownerId of bucket) {
          const owner = other.rows.get(ownerId);

          if (!owner) continue;

          const current = relRead(owner, name);

          if (Array.isArray(current)) {
            relWrite(
              owner,
              name,
              current.map((id) => (id === oldId ? newId : id)),
            );
          } else if (current === oldId) {
            relWrite(owner, name, newId);
          }
        }
        continue;
      }

      // union target: surgical — rewrite only entries referencing THIS variant;
      // a same-id entry of another variant keeps its id and its bucket slot
      const probe: RelationEntry = { model: state.model, id: oldId };
      const rewritten: RelationEntry = { model: state.model, id: newId };

      for (const ownerId of [...bucket]) {
        const owner = other.rows.get(ownerId);

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
  const states = statesOfScope(normalizeHomeScope(scope));

  if (!states) return [];

  return [...states].map((state) => ({
    model: state.model.name ?? null,
    kind: state.model.kind,
    count: state.rows.size,
    indexes: [
      ...[...state.indexes.entries()].map(([field, buckets]) => ({
        field,
        kind: "eq" as const,
        size: buckets.size,
      })),
      ...[...state.ordered.entries()].map(([field, ord]) => ({
        field,
        kind: "ord" as const,
        size: ord.byId.size,
      })),
    ],
    plans: state.plans.size,
    pooledScopes: state.pool.length,
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

// V8 holds hidden-class transitions weakly: a memory-reducing collection while
// no instance is alive (e.g. after removing every row) drops these maps, and
// the optimized code built on them deoptimizes. Synthetic instances keep them.
export const retainedModelShapes: readonly object[] = (() => {
  const registry = { next: 0 } as unknown as CollectionState;
  const retained: object[] = [];
  // A facade binds detachable methods onto its target on first access; keep
  // the common orders of those additions too.
  for (const methods of [[], ["json"], ["json", "dispose"], ["dispose"], ["onCleanup"]]) {
    const instance = new NativeInstance(registry, undefined, "shape", 0, 1, false);
    const facade = createInstanceFacade(instance as unknown as InstanceInternal);
    for (const method of methods) void (facade as Record<string, unknown>)[method];
    retained.push(instance, facade);
  }
  const completion = new DisposalCompletion();
  completion.trace = {};
  retained.push(completion);
  return retained;
})();
