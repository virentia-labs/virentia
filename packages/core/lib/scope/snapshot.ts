import type { Scope } from "./types";
import { NativeScope, NativeModelScope } from "./native";
import { trackUnitDeclaration } from "../graph/declaration";
import { unwrapMicroScope } from "./micro";
import { isPendingStoreValue, readTransactionStore } from "../kernel/transaction";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | {
      readonly [key: string]: JsonValue;
    };

/** JSON-safe writable store values keyed by their stable, resolved SID. */
export type ScopeSnapshot = Record<string, JsonValue>;

export interface SnapshotStore {
  readonly sid: string;
  readonly id: symbol;
  readonly identity: object;
  readonly scope?: Scope;
  /** Native declaration default; no scoped copy is needed until it changes. */
  readonly initial?: unknown;
}

/** @internal Cache/state identity captured during a synchronous declaration frame. */
export interface StoreDeclaration {
  readonly id: symbol;
  readonly sid?: string;
  readonly identity: object;
}

interface ModelSnapshotIdentity {
  id: string;
  automatic: boolean;
  key?: string;
}

interface RestoredIdentities {
  rows: Map<string, ModelSnapshotIdentity>;
  automatic: string[];
  nextAutomatic: number;
}

interface SnapshotState {
  pending: ScopeSnapshot;
  pendingCount?: number;
  stores: Map<string, SnapshotStore>;
  plainHeads?: Map<string, number>;
  /** Plain heads inside the model instance namespace, the only ones an instance can collide with. */
  instanceHeads?: number;
  models?: Map<string, ModelScopeBinding | Set<ModelScopeBinding>>;
  instances?: Record<string, Map<string, ModelSnapshotIdentity | ModelScopeBinding>>;
  restoredInstances?: Record<string, RestoredIdentities>;
  /**
   * Model instances register their SID namespace and identity when created
   * once the root hydrates or a snapshot reader has run. Until then their
   * collections only mark them, and the first reader registers them in order.
   */
  eager?: boolean;
  /** Collections whose live instances are still unregistered. */
  deferred?: Set<DeferredModelSnapshots>;
  /** Instance namespace prefixes (`instance:<type>:`) of deferred collections with SID fields. */
  deferredNamespaces?: Set<string>;
  /** Snapshot types of the deferred collections: a second collection of one type registers eagerly. */
  deferredTypes?: Set<string>;
}

/** @internal A model collection that registers its instances only once a snapshot reader needs them. */
export interface DeferredModelSnapshots {
  /** Whether new instances still defer their registration. */
  snapshotDeferred: boolean | undefined;
  /**
   * Register the identities of live deferred instances in collection order and
   * append those with a SID namespace, which register across collections in
   * creation order.
   */
  flushDeferredSnapshots(namespaces: DeferredModelNamespace[]): void;
}

/** @internal A deferred instance SID namespace. */
export interface DeferredModelNamespace {
  readonly snapshotSequence: number;
  registerSnapshotNamespace(): void;
}

/** Snapshot states with unconsumed values; while none exist, reads skip the per-root lookup. */
let pendingSnapshots = 0;

const states = new WeakMap<Scope, SnapshotState>();
export interface ModelScopeBinding {
  root: Scope;
  scope: Scope;
  prefix: string;
  head: string;
  owns: ReadonlySet<unknown>;
  stores?: ReadonlyMap<string, SnapshotStore>;
  shared?: boolean;
  registered?: boolean;
  id?: string;
  automatic?: boolean;
  instance?: object;
  active?: boolean;
  /** The binding's collection has not registered it yet (see `SnapshotState.eager`). */
  snapshotDeferred?: boolean;
}
const modelScopes = new WeakMap<Scope, ModelScopeBinding>();
/** @internal A native instance scope, not a separately registered application root. */
export function createModelScope(
  values: Scope["values"],
  handlers: Scope["handlers"],
  deps: Scope["deps"],
): Scope {
  return new NativeModelScope(values, handlers, deps);
}
const noModelLocals: ReadonlySet<unknown> = new Set();

/** Instance identity and its SID namespace share one weak scope registration. */
export function modelScopeInstance(scope: Scope): object | undefined {
  return NativeScope.readModel(scope, modelScopes)?.instance;
}

/** @internal Model and tracking scopes still belong to one application root. */
export function applicationScopeOf(scope: Scope): Scope {
  let current = unwrapMicroScope(scope);
  for (;;) {
    const root = NativeScope.readModel(current, modelScopes)?.root;
    if (!root || root === current) return current;
    current = unwrapMicroScope(root);
  }
}

export function registerModelScopeInstance(scope: Scope, instance: object): void {
  const binding = NativeScope.readModel(scope, modelScopes);
  if (binding) {
    if (binding.instance !== instance) binding.instance = instance;
  } else {
    NativeScope.writeModel(
      scope,
      {
        scope,
        root: scope,
        prefix: "",
        head: "",
        owns: noModelLocals,
        active: false,
        instance,
      },
      modelScopes,
    );
  }
}
const transient = new WeakSet<object>();
const instancesKey = "__virentia_model_instances__";
/** Model instance SID namespaces start `instance:<encoded type>:`. */
const instanceNamespace = "instance:";
/** A renderer can postpone structural path formatting until a SID is declared. */
export type SidScopeFrame = string | { toString(): string };
let sidScope: SidScopeFrame = "";
let declarationTracker: ((declaration: StoreDeclaration) => void) | undefined;

/** @internal Observe stores created in this synchronous frame, without owning their lifetime. */
export function withStoreDeclarationTracker<T>(
  callback: (declaration: StoreDeclaration) => void,
  body: () => T,
): T {
  const previous = declarationTracker;
  declarationTracker = callback;
  try {
    return body();
  } finally {
    declarationTracker = previous;
  }
}

/** @internal Called only after a store's proxy and its backing maps are ready. */
export function trackStoreDeclaration(declaration: StoreDeclaration): void {
  trackUnitDeclaration("store");
  declarationTracker?.(declaration);
}

// The same for the core's own stores and computeds: the declaration object is
// built only for an installed tracker (an optional call skips its arguments).
/** @internal */
export function trackNativeStoreDeclaration(
  id: symbol,
  sid: string | undefined,
  identity: object,
): void {
  trackUnitDeclaration("store");
  declarationTracker?.({ id, sid, identity });
}

/** @internal */
export function trackComputedDeclaration(id: symbol, identity: object): void {
  trackUnitDeclaration("store");
  declarationTracker?.({ id, identity });
}

/** @internal Release one component-owned store after its reactions have stopped. */
export function releaseStoreDeclaration(scope: Scope, declaration: StoreDeclaration): void {
  scope = unwrapMicroScope(scope);
  const state = states.get(scope);
  const registered = declaration.sid === undefined ? undefined : state?.stores.get(declaration.sid);
  if (registered && registered.identity !== declaration.identity) return;
  scope.values.delete(declaration.id);
  NativeModelScope.forgetComputedState(scope, declaration.identity);
  if (registered) forgetPlainStore(state!, registered.sid);
}

/** @internal Synchronous declaration namespace; restored immediately, including for a promise result. */
export function withSidScope<T>(prefix: string, callback: () => T): T {
  const previous = sidScope;
  sidScope = prefix;
  try {
    return callback();
  } finally {
    sidScope = previous;
  }
}

/** @internal Synchronous renderer frame; the caller restores the returned namespace. */
export function setSidScope(prefix: string): string {
  const previous = String(sidScope);
  sidScope = prefix;
  return previous;
}

/** @internal Restore this exact frame without forcing lazy renderer paths. */
export function setSidScopeFrame(prefix: SidScopeFrame): SidScopeFrame {
  const previous = sidScope;
  sidScope = prefix;
  return previous;
}

/** @internal Resolve at declaration, not at a later read in another owner. */
export function resolveStoreSid(sid: string | undefined): string | undefined {
  if (sid === undefined) return undefined;
  if (typeof sid !== "string" || !sid.length)
    throw new TypeError("Store SID must be a non-empty string");
  return sidScope ? `${sidScope}/${sid}` : sid;
}

/** @internal Snapshot input is cloned so requests cannot share mutable payloads. */
export function initializeSnapshot(scope: Scope, snapshot: ScopeSnapshot): void {
  const pending = cloneJson(snapshot, "snapshot", new Set());
  if (!pending || Array.isArray(pending) || typeof pending !== "object") {
    throw new TypeError("Scope snapshot must be a plain record of SID values");
  }
  const manifest = (pending as Record<string, unknown>)[instancesKey] as
    | Record<string, ModelSnapshotIdentity[]>
    | undefined;
  let restoredInstances: SnapshotState["restoredInstances"];
  if (manifest !== undefined) {
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest))
      throw new TypeError("Invalid model instance manifest");
    restoredInstances = Object.create(null) as NonNullable<SnapshotState["restoredInstances"]>;
    for (const [type, rows] of Object.entries(manifest)) {
      if (
        !Array.isArray(rows) ||
        rows.some((row) => typeof row?.id !== "string" || typeof row.automatic !== "boolean")
      )
        throw new TypeError("Invalid model instance manifest entry");
      restoredInstances[type] = {
        rows: new Map(rows.map((row) => [row.id, row])),
        automatic: rows.filter((row) => row.automatic).map((row) => row.id),
        nextAutomatic: 0,
      };
    }
    delete (pending as Record<string, unknown>)[instancesKey];
  }
  const previous = states.get(scope);
  if (previous) flushDeferredModels(previous);
  const pendingCount = Object.keys(pending).length;
  if (pendingCount) pendingSnapshots++;
  states.set(scope, {
    pending: pending as ScopeSnapshot,
    pendingCount,
    stores: new Map(),
    restoredInstances,
    eager: true,
  });
}

/**
 * @internal Start deferring a collection's instance registration in `root`,
 * unless a snapshot reader already ran there, the root hydrates, or another
 * collection shares the snapshot type (same-named models must collide when
 * their instances are created). Returns the root's snapshot state handle.
 */
export function deferModelSnapshots(
  root: Scope,
  source: DeferredModelSnapshots,
  type: string,
  namespace: string | undefined,
): object | undefined {
  const state = snapshotState(root);
  if (state.eager) return;
  if (state.deferredTypes?.has(type)) {
    flushDeferredModels(state);
    return;
  }
  (state.deferredTypes ??= new Set()).add(type);
  // The manifest lists types in the order their first instance registered.
  (state.instances ??= Object.create(null) as NonNullable<SnapshotState["instances"]>)[type] ??=
    new Map();
  (state.deferred ??= new Set()).add(source);
  if (namespace !== undefined) (state.deferredNamespaces ??= new Set()).add(namespace);
  source.snapshotDeferred = true;
  return state;
}

/**
 * @internal Bind a deferred instance's scope to it without registering its
 * namespace. False when the instance must register now: the root turned
 * eager, or a plain store already claims its namespace.
 */
export function deferModelNamespace(
  handle: object,
  scope: Scope | undefined,
  binding: ModelScopeBinding,
): boolean {
  const state = handle as SnapshotState;
  if (state.eager) return false;
  // A light instance has no scope yet, but its namespace may already collide.
  if (state.instanceHeads && binding.stores?.size && state.plainHeads!.has(binding.head)) {
    flushDeferredModels(state);
    return false;
  }
  if (scope) NativeScope.writeModel(scope, binding, modelScopes);
  return true;
}

/** @internal Register the root's deferred instances now (see `flushDeferredModels`). */
export function flushModelSnapshots(handle: object): void {
  flushDeferredModels(handle as SnapshotState);
}

/** Register every deferred instance in the root; from now on instances register when created. */
function flushDeferredModels(state: SnapshotState): void {
  if (state.eager) return;
  state.eager = true;
  const sources = state.deferred;
  state.deferred = state.deferredNamespaces = state.deferredTypes = undefined;
  if (!sources) return;
  const namespaces: DeferredModelNamespace[] = [];
  for (const source of sources) {
    source.snapshotDeferred = false;
    source.flushDeferredSnapshots(namespaces);
  }
  if (namespaces.length > 1) namespaces.sort(bySnapshotSequence);
  for (const namespace of namespaces) namespace.registerSnapshotNamespace();
}
function bySnapshotSequence(left: DeferredModelNamespace, right: DeferredModelNamespace): number {
  return left.snapshotSequence - right.snapshotSequence;
}

/** @internal Stable state addresses for one native static-model scope. */
export function registerModelSnapshotScope(
  scope: Scope,
  root: Scope,
  prefix: string,
  owns: ReadonlySet<unknown>,
  stores?: ReadonlyMap<string, SnapshotStore>,
  instanceBinding?: ModelScopeBinding,
): boolean {
  const binding: ModelScopeBinding = instanceBinding ?? {
    root,
    scope,
    prefix,
    head: sidHead(prefix),
    owns,
    stores,
    shared: Boolean(stores),
    instance: NativeScope.readModel(scope, modelScopes)?.instance,
  };
  if (stores?.size) {
    const state = snapshotState(root);
    if (state.deferred) flushDeferredModels(state);
    const head = sidHead(prefix);
    const previous = state.models?.get(head);
    if (previous || state.plainHeads?.has(head))
      for (const store of stores.values()) checkModelSid(state, binding, store);
    insertModelBinding(binding, state, head, previous);
  }
  NativeScope.writeModel(scope, binding, modelScopes);
  return Boolean(stores?.size && states.get(root)?.pendingCount);
}

function registerModelBinding(binding: ModelScopeBinding, state: SnapshotState): void {
  if (binding.registered) return;
  const head = binding.head;
  insertModelBinding(binding, state, head, state.models?.get(head));
}
function insertModelBinding(
  binding: ModelScopeBinding,
  state: SnapshotState,
  head: string,
  previous: ModelScopeBinding | Set<ModelScopeBinding> | undefined,
): void {
  binding.registered = true;
  const models = (state.models ??= new Map());
  if (!previous) models.set(head, binding);
  else if (previous instanceof Set) previous.add(binding);
  else models.set(head, new Set([previous, binding]));
}

export function releaseModelSnapshotScope(scope: Scope): void {
  const binding = NativeScope.readModel(scope, modelScopes);
  if (!binding) return;
  // Only a registered binding is in the registry; a deferred one never was.
  if (binding.registered) {
    const models = states.get(binding.root)?.models;
    const group = models?.get(binding.head);
    if (group instanceof Set) {
      group.delete(binding);
      if (group.size === 1) models!.set(binding.head, group.values().next().value!);
      else if (!group.size) models!.delete(binding.head);
    } else if (group === binding) {
      models!.delete(binding.head);
    }
  }
  // A finished instance still identifies parked continuations until its scope
  // is recycled. It no longer participates in SID materialization/serialization.
  if (!binding.instance) NativeScope.releaseModel(scope, modelScopes);
  else if (binding.active !== false) binding.active = false;
}

/** @internal A pooled instance scope no longer identifies its finished instance. */
export function forgetPooledModelScope(scope: Scope): void {
  NativeScope.releaseModel(scope, modelScopes);
}

export function releaseModelSnapshotNamespace(root: Scope, prefix: string): void {
  const state = states.get(root);
  for (const [sid, store] of state?.stores ?? []) {
    if (!sid.startsWith(prefix + "/")) continue;
    (store.scope ?? root).values.delete(store.id);
    forgetPlainStore(state!, sid);
  }
  const group = state?.models?.get(sidHead(prefix));
  for (const binding of group instanceof Set ? group : group ? [group] : []) {
    for (const [sid, store] of binding.stores ?? []) {
      if (!`${binding.prefix}/${sid}`.startsWith(prefix + "/")) continue;
      binding.scope.values.delete(store.id);
      writableModelStores(binding).delete(sid);
    }
  }
}

export function registerModelSnapshotIdentity(
  root: Scope,
  type: string,
  id: string,
  automatic: boolean,
  key?: string,
  modelScope?: Scope,
): void {
  const state = snapshotState(root);
  if (state.deferred) flushDeferredModels(state);
  const table: NonNullable<SnapshotState["instances"]> = (state.instances ??= Object.create(null));
  const rows = (table[type] ??= new Map());
  if (!rows.has(id)) {
    const binding = modelScope && NativeScope.readModel(modelScope, modelScopes);
    if (binding && binding.prefix === key) {
      binding.id = id;
      binding.automatic = automatic;
      rows.set(id, binding);
    } else rows.set(id, key === undefined ? { id, automatic } : { id, automatic, key });
  }
}

function snapshotIdentity(row: ModelSnapshotIdentity | ModelScopeBinding): ModelSnapshotIdentity {
  return "prefix" in row ? { id: row.id!, automatic: row.automatic!, key: row.prefix } : row;
}

export function releaseModelSnapshotIdentity(root: Scope, type: string, id: string): void {
  const state = states.get(root);
  if (state?.deferred) flushDeferredModels(state);
  const rows = state?.instances?.[type];
  rows?.delete(id);
}

export function restoredModelIdentity(
  root: Scope,
  type: string,
  suppliedId?: string,
): { id: string; key?: string } | undefined {
  const restored = states.get(root)?.restoredInstances?.[type];
  if (!restored) return;
  if (suppliedId === undefined) {
    // Advance once across the manifest, including IDs already consumed explicitly.
    // Repeated findIndex/splice made a large hydration quadratic too.
    while (restored.nextAutomatic < restored.automatic.length) {
      const id = restored.automatic[restored.nextAutomatic++];
      const row = restored.rows.get(id);
      if (!row) continue;
      restored.rows.delete(id);
      return row;
    }
    return;
  }
  const row = restored.rows.get(suppliedId);
  restored.rows.delete(suppliedId);
  return row;
}

/** DOM reference values are infrastructure, including explicitly SID-tagged ref stores. */
export function markStoreTransient(store: { node: unknown }): void {
  if (typeof store.node === "object" && store.node) transient.add(store.node);
}

/** @internal Copy lazy SID restoration into a temporary in-memory read scope. */
export function copyScopeSnapshotState(source: Scope, target: Scope): void {
  const state = states.get(source);
  if (!state) return;
  flushDeferredModels(state);
  if (state.pendingCount) pendingSnapshots++;
  states.set(target, {
    pending: cloneJson(state.pending, "snapshot", new Set()) as ScopeSnapshot,
    pendingCount: state.pendingCount,
    stores: new Map(state.stores),
    plainHeads: state.plainHeads && new Map(state.plainHeads),
    instanceHeads: state.instanceHeads,
    eager: true,
    models:
      state.models &&
      new Map(
        Array.from(state.models, ([head, group]) => {
          const copy = (binding: ModelScopeBinding): ModelScopeBinding => ({
            scope: binding.scope,
            prefix: binding.prefix,
            head: binding.head,
            owns: binding.owns,
            shared: binding.shared,
            registered: binding.registered,
            id: binding.id,
            automatic: binding.automatic,
            root: target,
            stores: binding.stores && new Map(binding.stores),
          });
          return [head, group instanceof Set ? new Set(Array.from(group, copy)) : copy(group)];
        }),
      ),
    instances:
      state.instances &&
      mapIdentityTable(
        state.instances,
        (rows) => new Map(Array.from(rows, ([id, row]) => [id, { ...snapshotIdentity(row) }])),
      ),
    restoredInstances:
      state.restoredInstances &&
      mapIdentityTable(state.restoredInstances, (restored) => ({
        rows: new Map(Array.from(restored.rows, ([id, row]) => [id, { ...row }])),
        automatic: [...restored.automatic],
        nextAutomatic: restored.nextAutomatic,
      })),
  });
}

function mapIdentityTable<T, U>(table: Record<string, T>, map: (rows: T) => U): Record<string, U> {
  const copy = Object.create(null) as Record<string, U>;
  for (const [type, rows] of Object.entries(table)) copy[type] = map(rows);
  return copy;
}

/** @internal Bind only writable stores; computed caches never enter the registry. */
export function materializeSnapshotStore(scope: Scope, store: SnapshotStore): boolean {
  const binding = NativeScope.readModel(scope, modelScopes);
  if (binding && binding.active !== false) {
    const existing = binding.stores?.get(store.sid);
    scope = binding.root;
    if (existing === store || binding.owns.has(store.id)) {
      // A model field read: nothing to register or restore.
      if (
        existing === store &&
        (binding.registered || binding.snapshotDeferred) &&
        (!pendingSnapshots || !states.get(scope)?.pendingCount)
      )
        return false;
      const state = snapshotState(scope);
      // An instance-owned store outside the declared fields: register the namespace now.
      if (binding.snapshotDeferred) flushDeferredModels(state);
      registerModelBinding(binding, state);
      if (existing && existing.identity !== store.identity)
        duplicateSid(`${binding.prefix}/${store.sid}`);
      if (!existing) {
        checkModelSid(state, binding, store);
        writableModelStores(binding).set(store.sid, store);
      }
      return restoreSnapshotStore(
        state,
        binding.scope,
        store,
        state.pendingCount ? `${binding.prefix}/${store.sid}` : undefined,
      );
    }
  }
  const state = snapshotState(scope);
  const existing = state.stores.get(store.sid);
  if (existing === store && (!state.pendingCount || (store.scope ?? scope).values.has(store.id)))
    return false;
  if (existing && existing.identity !== store.identity) duplicateSid(store.sid);
  if (!existing) {
    const head = sidHead(store.sid);
    // A deferred collection's instances may own this namespace: register them first.
    if (state.deferredNamespaces && head.startsWith(instanceNamespace)) {
      const end = head.indexOf(":", instanceNamespace.length);
      if (end > 0 && state.deferredNamespaces.has(head.slice(0, end + 1)))
        flushDeferredModels(state);
    }
    const group = state.models?.get(head);
    for (const model of group instanceof Set ? group : group ? [group] : []) {
      if (!store.sid.startsWith(model.prefix + "/")) continue;
      const previous = model.stores?.get(store.sid.slice(model.prefix.length + 1));
      if (previous && previous.identity !== store.identity) duplicateSid(store.sid);
    }
    if (store.sid.includes("/")) {
      const heads = (state.plainHeads ??= new Map());
      const count = heads.get(head) ?? 0;
      heads.set(head, count + 1);
      if (!count && head.startsWith(instanceNamespace))
        state.instanceHeads = (state.instanceHeads ?? 0) + 1;
    }
  }
  if (existing !== store) state.stores.set(store.sid, store);
  return restoreSnapshotStore(state, store.scope ?? scope, store, store.sid);
}

function writableModelStores(binding: ModelScopeBinding): Map<string, SnapshotStore> {
  if (!binding.stores || binding.shared) {
    binding.stores = new Map(binding.stores);
    binding.shared = false;
  }
  return binding.stores as Map<string, SnapshotStore>;
}

function checkModelSid(
  state: SnapshotState,
  binding: ModelScopeBinding,
  store: SnapshotStore,
): void {
  const group = state.models?.get(binding.head);
  for (const other of group instanceof Set ? group : group ? [group] : []) {
    if (other === binding) continue;
    const sid = `${binding.prefix}/${store.sid}`;
    if (!sid.startsWith(other.prefix + "/")) continue;
    const previous = other.stores?.get(sid.slice(other.prefix.length + 1));
    if (previous && previous.identity !== store.identity) duplicateSid(sid);
  }
  if (state.plainHeads?.has(binding.head)) {
    const sid = `${binding.prefix}/${store.sid}`;
    const previous = state.stores.get(sid);
    if (previous && previous.identity !== store.identity) duplicateSid(sid);
  }
}

function snapshotState(scope: Scope): SnapshotState {
  let state = states.get(scope);
  if (!state) states.set(scope, (state = { pending: Object.create(null), stores: new Map() }));
  return state;
}

/** @internal Native model fields are registered by their constructor already. */
export function hasPendingSnapshot(scope: Scope): boolean {
  return pendingSnapshots > 0 && Boolean(states.get(scope)?.pendingCount);
}

function sidHead(sid: string): string {
  const slash = sid.indexOf("/");
  return slash < 0 ? sid : sid.slice(0, slash);
}

function duplicateSid(sid: string): never {
  throw new Error(
    `Duplicate store SID "${sid}" in one scope. ` +
      "Give each store a unique SID or namespace repeated factory/component instances with withSidScope().",
  );
}

function forgetPlainStore(state: SnapshotState, sid: string): void {
  if (!state.stores.delete(sid) || !sid.includes("/")) return;
  const head = sidHead(sid),
    count = state.plainHeads?.get(head);
  if (count === 1) {
    state.plainHeads!.delete(head);
    if (head.startsWith(instanceNamespace)) state.instanceHeads!--;
  } else if (count) state.plainHeads!.set(head, count - 1);
}

function restoreSnapshotStore(
  state: SnapshotState,
  scope: Scope,
  store: SnapshotStore,
  sid?: string,
): boolean {
  if (!state.pendingCount || !sid || !Object.hasOwn(state.pending, sid)) return false;
  const restored = !scope.values.has(store.id);
  if (restored) scope.values.set(store.id, state.pending[sid]);
  delete state.pending[sid];
  if (!--state.pendingCount) pendingSnapshots--;
  return restored;
}

/**
 * Serialize materialized writable SID stores; handlers, dependencies and derived caches are excluded.
 * The result is cloned JSON data, not HTML-safe text for embedding in a script tag.
 *
 * Use an explicit request scope. Direct awaits of Virentia units restore their
 * caller's context; arbitrary native promises do not provide that guarantee.
 */
export function serialize(scope: Scope): ScopeSnapshot {
  scope = unwrapMicroScope(scope);
  const snapshot = Object.create(null) as ScopeSnapshot;
  const state = states.get(scope);
  if (!state) return snapshot;
  flushDeferredModels(state);
  for (const [sid, store] of state.stores) {
    if (transient.has(store.identity)) continue;
    const source = store.scope ?? scope;
    if (source.values.has(store.id) || Object.hasOwn(store, "initial")) {
      const pending = readTransactionStore(source, store.id);
      const value = isPendingStoreValue(pending)
        ? pending
        : source.values.has(store.id)
          ? source.values.get(store.id)
          : store.initial;
      snapshot[sid] = cloneJson(value, `store "${sid}"`, new Set());
    }
  }
  const serializeModel = (binding: ModelScopeBinding): void => {
    for (const [localSid, store] of binding.stores ?? []) {
      if (
        transient.has(store.identity) ||
        (!binding.scope.values.has(store.id) && !Object.hasOwn(store, "initial"))
      )
        continue;
      const sid = `${binding.prefix}/${localSid}`;
      const pending = readTransactionStore(binding.scope, store.id);
      const value = isPendingStoreValue(pending)
        ? pending
        : binding.scope.values.has(store.id)
          ? binding.scope.values.get(store.id)
          : store.initial;
      snapshot[sid] = cloneJson(value, `store "${sid}"`, new Set());
    }
  };
  for (const group of state.models?.values() ?? []) {
    if (group instanceof Set) for (const binding of group) serializeModel(binding);
    else serializeModel(group);
  }
  if (state.instances && Object.values(state.instances).some((rows) => rows.size))
    snapshot[instancesKey] = cloneJson(
      Object.fromEntries(
        Object.entries(state.instances).map(([type, rows]) => [
          type,
          Array.from(rows.values(), snapshotIdentity),
        ]),
      ),
      "model instances",
      new Set(),
    );
  return snapshot;
}

function cloneJson(value: unknown, path: string, ancestors: Set<object>): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (Number.isFinite(value) && !Object.is(value, -0)) return value;
    throw new TypeError(
      `Cannot serialize ${path}: expected a finite JSON number without negative zero`,
    );
  }
  if (typeof value !== "object")
    throw new TypeError(`Cannot serialize ${path}: unsupported ${typeof value} value`);
  if (ancestors.has(value)) throw new TypeError(`Cannot serialize ${path}: cyclic value`);
  const array = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (!array && prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`Cannot serialize ${path}: expected a plain JSON object`);
  }
  ancestors.add(value);
  try {
    const result: JsonValue[] | Record<string, JsonValue> = array ? [] : Object.create(null);
    const keys = Reflect.ownKeys(value);
    if (array && keys.length !== value.length + 1) {
      throw new TypeError(
        `Cannot serialize ${path}: sparse arrays and extra array properties are unsupported`,
      );
    }
    for (const key of keys) {
      if (array && key === "length") continue;
      if (typeof key !== "string")
        throw new TypeError(`Cannot serialize ${path}: symbol keys are unsupported`);
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (!descriptor.enumerable || !("value" in descriptor)) {
        throw new TypeError(
          `Cannot serialize ${path}.${key}: accessors and non-enumerable properties are unsupported`,
        );
      }
      if (array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)) {
        throw new TypeError(`Cannot serialize ${path}: extra array properties are unsupported`);
      }
      (result as Record<string, JsonValue>)[key] = cloneJson(
        descriptor.value,
        `${path}.${key}`,
        ancestors,
      );
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}
