import { dynamicInstantiation, setDynamicModelRuntime } from "./dynamic-runtime";
import { definitionBrand, instanceTargetKey, InstanceTarget, instanceInternalOf } from "./protocol";
export { isModelDefinition, isModelInstance, instanceInternalOf } from "./protocol";
import { trackNode, isTracking, untrackedRead } from "../graph/deps";
import { node, runDetached, type Node } from "../kernel";
import {
  owner,
  withOwner,
  withoutOwner,
  getOwner,
  setOwner,
  ownedUnsubscribe,
  DeferredOwner,
} from "../graph/owner";
import { reportContainedError } from "../kernel/report";
import { describeNode } from "../kernel/inspector";
import type { Owned, Owner } from "../graph/owner";
import { ModelTaskOwner } from "./task-owner";
import { NativeModelScope } from "../scope/native";
import { setReactionConfigTransform } from "../graph/reaction";
import { bindStoreSubscription, boundStoreAlive, setModelStoreScopeResolver } from "../units/binding";
import {
  getActiveScope,
  runScopeTask,
  readScopeTaskValue,
  setActiveScope,
} from "../scope/internal";
import { unwrapMicroScope } from "../scope/micro";
import type { Scope } from "../scope/types";
import {
  seedScopeStoreValue,
  seedModelStoreValue,
  fixedScopedStoreNode,
  readScopeStoreValue,
  nativeStoreStateOf,
  isBootstrapScope,
  nativeStoreApiOf,
  nativeModelStoreInfoOf,
  readModelStoreState,
  readsValueNatively,
  subscribeComputedInScope,
  apiPrototypeOf,
  type NativeStoreState,
  store,
} from "../units/store";
import { bindEventToScope, boundEventScopeOf, boundScopeKey, type EventCallable } from "../units/event";
import { runUnitScoped } from "../kernel/run";
import type { StoreWritable } from "../units/store";
import {
  registerDirectModelMembers,
  registerModelValueScopeBinder,
  type DirectModelMember,
  modelInstanceBinding,
  modelViewSnapshot,
  modelDefaultViewSnapshot,
  modelViewCapture,
  type ModelInstanceBinding,
  type ModelViewCapture,
  type ModelBindingData,
  type ModelDisposalTrace,
  type ModelDisposalParticipant,
  modelValueBindingOf,
  setModelSetupContext,
  type ModelValueContext,
  type ModelSetupContext,
} from "./bindings";
import { activeTransactionDepth } from "../kernel/transaction";
import { composeShape, resolveDataDeclaration } from "./trait";
import type { DataDeclaration, TraitDef } from "./trait";
import { fieldIsOneWay, fieldOut } from "./fields";
import type { FieldDef } from "./fields";
import { Self, isInverseDef, isRelationDef } from "./relations";
import type { InverseDef, RelationDef } from "./relations";
import type {
  AnyTraitTyped,
  Instance,
  LocalizeUnbound,
  MembersRecord,
  ModelWithDescriptors,
  SelfOf,
  ShapeRecord,
  TraitsMembers,
  TraitsProps,
  TraitsRequiredBehaviors,
  TraitsShape,
  TypedQuery,
  Predicate,
  SortToken,
} from "./types";
import type { AddOptions, Collection, CollectionState } from "./collection";
import type { Props } from "./fields";
import {
  withStoreDeclarationTracker,
  modelScopeInstance,
  registerModelScopeInstance,
  createModelScope,
  type StoreDeclaration,
} from "../scope/snapshot";
import { sequenceBinding } from "../sequence";
import { retainScopeTask } from "../scope/tasks";
import { retainShapes } from "../kernel/shapes";

// §3: two model kinds with one declaration form and one usage surface. `data`
// resolves ONCE for both; the kinds differ in unit instantiation only:
//   model        — stores and units are created per instance (setup(self, props));
//   staticModel  — stores and units exist once, an instance is a scope (setup(self)).

export interface ModelConfig {
  with?: readonly TraitDef[];
  data?: DataDeclaration;
  setup?: (self: never, props?: never) => Record<string, unknown> | void;
  /** Synchronous per-instance initialization after fields, members and children are ready. */
  onCreate?: (self: never) => void;
  name?: string;
  id?: (props: Record<string, unknown>) => string;
  sid?: string;
}

export type ModelKind = "dynamic" | "static";

export interface FieldRuntime {
  readonly name: string;
  readonly def: FieldDef;
  /** static: the single store shared by the collection; dynamic: created per instance. */
  readonly staticStore?: StoreWritable<unknown>;
}

export interface RelationRuntime {
  readonly name: string;
  readonly def: RelationDef;
  /** backing state: target id (one) or ordered id list (many). */
  readonly staticStore?: StoreWritable<unknown>;
}

export interface InverseRuntime {
  readonly name: string;
  readonly def: InverseDef;
}

export interface ModelDefinition {
  /** @internal Dedicated native-unit graph owned by another model definition. */
  readonly "~singletonOf"?: ModelDefinition;
  readonly "~model": true;
  readonly kind: ModelKind;
  readonly name?: string;
  readonly idFromProps?: (props: Record<string, unknown>) => string;
  readonly sid?: string;
  readonly fields: ReadonlyMap<string, FieldRuntime>;
  readonly relations: ReadonlyMap<string, RelationRuntime>;
  readonly inverses: ReadonlyMap<string, InverseRuntime>;
  readonly behaviors: ReadonlySet<string>;
  readonly traits: readonly TraitDef[];
  /** field → declaring trait identity; drives union commonality (§5.2). */
  readonly fieldOrigins: ReadonlyMap<string, TraitDef>;
  /** static only: members produced by trait setups + model setup, shared by all instances. */
  readonly staticMembers?: ReadonlyMap<string, unknown>;
  readonly setup?: ModelConfig["setup"];
  readonly onCreate?: ModelConfig["onCreate"];
  /** static only: ids of instance-local store state for scope routing (§3.2). */
  readonly locals?: ReadonlySet<unknown>;
  create(
    props: Record<string, unknown> | readonly Record<string, unknown>[],
    options?: AddOptions,
  ): unknown;
  static(input?: Record<string, unknown>): object;
  get(id: string): object | null;
  readonly instances: TypedQuery<object>;
  where(predicate: Predicate<any> | ((instance: object) => boolean)): TypedQuery<object>;
  sort(by: SortToken): TypedQuery<object>;
  take(count: number): TypedQuery<object>;
}

function instancesOf(definition: ModelDefinition): Collection {
  const access = (definition as ModelDefinition & { "~instancesInScope"?: () => Collection })[
    "~instancesInScope"
  ];
  if (!access) throw new Error("[models] Import model/staticModel from @virentia/core/models");
  return access();
}

const runtimeDefinitions = new WeakMap<ModelDefinition, ModelDefinition>();
/** Internal execution reads declaration metadata without descriptor Proxy traps. */
export function modelRuntimeOf(definition: ModelDefinition): ModelDefinition {
  return runtimeDefinitions.get(definition) ?? definition;
}
const RESERVED = new Set([
  // instance API (§3.1)
  "id",
  "key",
  "alive",
  "json",
  "toJSON",
  "dispose",
  "rebind",
  "onCleanup",
  // definition surface (§4.6)
  "create",
  "static",
  "get",
  "instances",
  "where",
  "sort",
  "take",
  "name",
  "kind",
  "fields",
  "relations",
  "inverses",
  "behaviors",
  "traits",
  "staticMembers",
  "setup",
  "onCreate",
  "locals",
  "fieldOrigins",
  "sid",
  "idFromProps",
]);

/** A model field, relation or store-like member observed by a synchronous read. */
export interface ModelFieldReadSource {
  subscribe(listener: () => void): () => void;
}

let modelFieldReadCollector: ((source: ModelFieldReadSource) => void) | null = null;

/** Collect model store reads without changing ordinary reactive reads outside this call. */
export function collectModelFieldReads<T>(
  collector: (source: ModelFieldReadSource) => void,
  read: () => T,
): T {
  const previous = modelFieldReadCollector;
  modelFieldReadCollector = collector;
  try {
    return read();
  } finally {
    modelFieldReadCollector = previous;
  }
}

function trackModelFieldRead(source: ModelFieldReadSource): void {
  if (modelFieldReadCollector) modelFieldReadCollector(source);
  // readBridge already tracks this instance's unit. Also observing the shared
  // raw node would notify a reader twice and leak writes from other instances.
}

// ---------------------------------------------------------------------------
// Instance-scope values: a Map that routes by static ownership (§3.2). Keys in
// `locals` (the model's field state) live in the instance's own map; everything
// else falls through to the parent scope — one `has` per access, no chain walk.
// Implemented as a Map subclass so the kernel needs no changes at all.

class ChainedValues extends Map<unknown, unknown> {
  constructor(
    private readonly parent: Map<unknown, unknown>,
    private readonly locals: ReadonlySet<unknown>,
  ) {
    super();
  }

  // Plain-store state is classified by its id symbol: anything that is not the
  // model's own field belongs to the application scope, ALWAYS — first touch
  // must not decide locality, or an app store read from an instance context
  // forks into a permanent per-instance shadow. Computed caches and other
  // per-scope state stay instance-local for isolation.
  private isForeignStore(key: unknown): boolean {
    // A field's own id answers from the Set before the slower symbol description.
    return typeof key === "symbol" && !this.locals.has(key) && key.description === "virentia.store";
  }

  override get(key: unknown): unknown {
    if (this.isForeignStore(key)) return this.parent.get(key);
    return super.get(key);
  }

  override has(key: unknown): boolean {
    if (this.isForeignStore(key)) return this.parent.has(key);
    return super.has(key);
  }

  override set(key: unknown, value: unknown): this {
    if (this.isForeignStore(key)) {
      this.parent.set(key, value);
      return this;
    }
    super.set(key, value);
    return this;
  }

  override delete(key: unknown): boolean {
    return super.delete(key);
  }
}
retainShapes("core/models/values", new ChainedValues(new Map(), new Set()));

export function createInstanceScope(parent: Scope, locals: ReadonlySet<unknown>): Scope {
  return createModelScope(
    new ChainedValues(parent.values, locals) as Scope["values"],
    parent.handlers,
    parent.deps,
  );
}

// ---------------------------------------------------------------------------
// Instance internals

export interface InstanceInternal {
  bindingData?: ModelBindingData | Map<symbol, ModelBindingData>;
  facade?: object;
  /** The target of `facade`. */
  facadeTarget?: object;
  facadeHandles?: unknown;
  firstFacadeHandle?: string;
  registry?: CollectionState;
  relationCache?: Map<string, object>;
  selfListeners?: Set<() => void>;
  detachSelf?: (() => void) | null;
  readonly definition: ModelDefinition;
  readonly runtimeDefinition: ModelDefinition;
  readonly parentScope: Scope;
  /** static only */
  readonly scope?: Scope;
  /**
   * static only: a light instance's field values by creation order, until its
   * scope is created on first use (collection.ts `materializeScope`).
   */
  fieldSeed?: unknown[];
  /** dynamic only: per-instance stores and members */
  ownStores?: ReadonlyMap<string, StoreWritable<unknown>>;
  ownMembers?: ReadonlyMap<string, unknown>;
  ownOwner?: Owned<object>;
  taskOwner?: Owner;
  declarations?: StoreDeclaration[];
  id: string;
  /** UI key — slot+generation (§10.1); stable across rebind, unique across reuse. */
  readonly key: string;
  /** §3.5: the handle IS { slot, generation } — a reused slot bumps the generation. */
  readonly slot: number;
  readonly generation: number;
  alive: boolean;
  temporaryId: boolean;
  /** Stable insertion rank within the owning collection, including after rebind. */
  insertionOrder: number;
  snapshotKey?: string;
  restoreSnapshot?: boolean;
  /** Its snapshot identity and SID namespace wait for the root's first snapshot reader. */
  snapshotDeferred?: boolean;
  /** `registry.instances.get(id) === this`, kept by every change to that map. */
  listed?: boolean;
  /** Its key in each eq index of its collection (`indexList` order); `unindexed` when absent. */
  indexKeys?: unknown[];
  props?: Record<string, unknown>;
  beforeDisposers?: ModelBeforeDisposer | Set<ModelBeforeDisposer>;
  ownedInstances?: Set<InstanceInternal>;
  owningInstance?: InstanceInternal;
  disposal?: { trace?: ModelDisposalTrace; promise(): Promise<void> };
  finalizing?: boolean;
  createOwned?: (definition: ModelDefinition, props: Record<string, unknown>) => object;
  /** §3.5: lazy Error, or a shared framework-site stack with no closure references. */
  disposedSite?: { readonly stack?: string };
  /** §3.5: reactive `alive` — registers an epoch dependency in the caller. */
  onAliveRead?: () => void;
  /** §10.4: external cleanups registered via `onCleanup` — run at dispose,
   * while the instance is still readable, before teardown. Lazy: only
   * instances that register pay. */
  disposers?: Set<() => void>;
  /** binding seam (§10.1): per-instance change feed — own field/relation
   * writes, dispose and rebind; attach/detach managed by the collection. */
  subscribeSelf?: (listener: () => void) => () => void;
  notifySelf?: () => void;
  onWrite?: (name: string, value: unknown) => void;
  /**
   * Runs before a rebind changes `id` (and clears `temporaryId`); throws to
   * reject the new id.
   */
  onBeforeRebind?: (newId: string) => void;
  onRebind?: (oldId: string, newId: string) => void;
  onDispose?: (instance: InstanceInternal, trace?: ModelDisposalTrace) => void | Promise<void>;
  /** relation/inverse views, provided by the collection (avoids a module cycle). */
  relationView?: (name: string) => object;
  /** relation wire output, provided by the collection (§9.1: children inline, refs by id). */
  serializeRelations?: (out: Record<string, unknown>) => void;
}

export type ModelBeforeDisposer = (() => void | PromiseLike<unknown>) | ModelDisposalParticipant;

export function getInstanceData(
  internal: InstanceInternal,
  key: symbol,
): ModelBindingData | undefined {
  const data = internal.bindingData;
  return data instanceof Map ? data.get(key) : data?.bindingKey === key ? data : undefined;
}
export function setInstanceData(internal: InstanceInternal, data: ModelBindingData): void {
  const previous = internal.bindingData;
  if (!previous || (!(previous instanceof Map) && previous.bindingKey === data.bindingKey))
    internal.bindingData = data;
  else if (previous instanceof Map) previous.set(data.bindingKey, data);
  else
    internal.bindingData = new Map([
      [previous.bindingKey, previous],
      [data.bindingKey, data],
    ]);
}
export function deleteInstanceData(internal: InstanceInternal, key: symbol): void {
  const data = internal.bindingData;
  if (data instanceof Map) {
    data.delete(key);
    if (data.size === 1) internal.bindingData = data.values().next().value;
    else if (!data.size) internal.bindingData = undefined;
  } else if (data?.bindingKey === key) internal.bindingData = undefined;
}

const facadeCachePrototype = Object.freeze(Object.create(null));
function createFacadeCache<T>(name: string, value: T): Record<string, T> {
  // One fast-property object for the usual small model surface. An empty
  // null-rooted prototype keeps every possible field name safe to look up.
  return { __proto__: facadeCachePrototype, [name]: value } as Record<string, T>;
}
function cacheFacadeHandle(internal: InstanceInternal, name: string, value: unknown): void {
  const first = internal.firstFacadeHandle;
  if (first !== undefined) {
    const handles = createFacadeCache(first, internal.facadeHandles);
    handles[name] = value;
    internal.facadeHandles = handles;
    internal.firstFacadeHandle = undefined;
  } else if (internal.facadeHandles === undefined) {
    internal.firstFacadeHandle = name;
    internal.facadeHandles = value;
  } else (internal.facadeHandles as Record<string, unknown>)[name] = value;
}
export function registerScopeInstance(scope: Scope, internal: InstanceInternal): void {
  registerModelScopeInstance(scope, internal);
}

/** Injected by collection.ts: live instances of a definition in a (normalized) scope. */
let broadcastResolver:
  | ((definition: ModelDefinition, scope: Scope) => readonly InstanceInternal[])
  | null = null;

export function setBroadcastResolver(resolver: typeof broadcastResolver): void {
  broadcastResolver = resolver;
}

let idCounter = 0;

export function instanceOfScope(scope: Scope): InstanceInternal | undefined {
  return modelScopeInstance(unwrapMicroScope(scope)) as InstanceInternal | undefined;
}

setModelStoreScopeResolver((scope, key) => {
  const instance = instanceOfScope(scope);
  if (!instance || instance.runtimeDefinition.kind !== "static" ||
      instance.runtimeDefinition.locals?.has(key)) return scope;
  return instance.parentScope;
});

function isOwnWrite(internal: InstanceInternal, scope: Scope): boolean {
  return internal.runtimeDefinition["~singletonOf"]
    ? unwrapMicroScope(scope) === internal.parentScope
    : internal.runtimeDefinition.kind === "dynamic" || instanceOfScope(scope) === internal;
}

type WriteListener = (value: unknown, scope: Scope) => void;
interface SharedUnit {
  readonly node: Node;
  subscribe(fn: WriteListener): () => void;
}
interface OwnWriteSubscription {
  readonly internal: InstanceInternal;
  readonly listener: WriteListener;
}
type OwnWriteRoute = OwnWriteSubscription | Set<OwnWriteSubscription>;
/** One shared unit's subscriptions; each instance scope holds its own route (`ownWriteRoute`). */
interface OwnWriteRoutes {
  count: number;
  detach?: () => void;
}
const ownWriteRoutes = new WeakMap<SharedUnit, OwnWriteRoutes>();
// An instance scope lists its routes as [routes, route, …] pairs: a scope has
// a route per subscribed field, usually one, so a write finds it without a
// lookup in a table of every instance.
const ownWritesFallback = new WeakMap<Scope, unknown[]>();
function ownWriteRoute(scope: Scope, routes: OwnWriteRoutes): OwnWriteRoute | undefined {
  const list = NativeModelScope.ownWrites(scope, ownWritesFallback);
  if (list)
    for (let index = 0; index < list.length; index += 2)
      if (list[index] === routes) return list[index + 1] as OwnWriteRoute;
  return undefined;
}
function setOwnWriteRoute(
  scope: Scope,
  routes: OwnWriteRoutes,
  route: OwnWriteRoute | undefined,
): void {
  const list = NativeModelScope.ownWrites(scope, ownWritesFallback);
  if (list)
    for (let index = 0; index < list.length; index += 2) {
      if (list[index] !== routes) continue;
      if (route) list[index + 1] = route;
      else if (list.length === 2)
        NativeModelScope.setOwnWrites(scope, undefined, ownWritesFallback);
      else list.splice(index, 2);
      return;
    }
  if (!route) return;
  if (list) list.push(routes, route);
  else NativeModelScope.setOwnWrites(scope, [routes, route], ownWritesFallback);
}

/**
 * Subscribe to one instance's writes of a unit shared by every instance of a
 * static model. While anyone listens, one dispatcher subscription on the unit
 * routes each write to the listeners of the instance scope it happened in, so
 * a write costs O(its own listeners) instead of O(every observed instance).
 */
function subscribeOwnWrites(
  internal: InstanceInternal,
  unit: SharedUnit,
  listener: WriteListener,
): () => void {
  if (!internal.alive) return () => {};
  const home = internal.scope;
  const definition = internal.runtimeDefinition;
  if (!home || definition.kind !== "static" || definition["~singletonOf"])
    return subscribeAnyWrite(internal, unit, listener);
  const scoped = subscribeComputedInScope(unit, home, listener);
  if (scoped) {
    const owner = taskOwnerOf(internal);
    const stop = withOwner(owner, () => ownedUnsubscribe(scoped));
    return getOwner() === owner ? stop : ownedUnsubscribe(stop);
  }
  let shared = ownWriteRoutes.get(unit);
  if (!shared) ownWriteRoutes.set(unit, (shared = { count: 0 }));
  if (!shared.count++) attachOwnWriteRoutes(unit, shared);
  const subscription: OwnWriteSubscription = { internal, listener };
  const route = ownWriteRoute(home, shared);
  if (!route) setOwnWriteRoute(home, shared, subscription);
  else if (route instanceof Set) route.add(subscription);
  else setOwnWriteRoute(home, shared, new Set([route, subscription]));
  // Closures live in helpers: one here would give every call a context
  // holding all of this function's captured variables.
  return ownedUnsubscribe(ownWriteRemover(shared, home, subscription));
}
function subscribeAnyWrite(
  internal: InstanceInternal,
  unit: SharedUnit,
  listener: WriteListener,
): () => void {
  return unit.subscribe((value, scope) => {
    if (isOwnWrite(internal, scope)) listener(value, scope);
  });
}
function attachOwnWriteRoutes(unit: SharedUnit, shared: OwnWriteRoutes): void {
  // Never capture an application or caller owner: the unit is shared.
  shared.detach = withoutOwner(() =>
    unit.subscribe((value, scope) => {
      const key = unwrapMicroScope(scope);
      const route = ownWriteRoute(key, shared);
      if (route) dispatchOwnWrite(unit, shared, key, route, value, scope);
    }),
  );
}
function ownWriteRemover(
  shared: OwnWriteRoutes,
  home: Scope,
  subscription: OwnWriteSubscription,
): () => void {
  return () => {
    if (dropOwnWrite(shared, home, subscription)) releaseOwnWriteRoute(shared);
  };
}
function dropOwnWrite(
  routes: OwnWriteRoutes,
  scope: Scope,
  subscription: OwnWriteSubscription,
): boolean {
  const route = ownWriteRoute(scope, routes);
  if (route === subscription) {
    setOwnWriteRoute(scope, routes, undefined);
    return true;
  }
  return route instanceof Set && route.delete(subscription);
}
function releaseOwnWriteRoute(routes: OwnWriteRoutes): void {
  if (--routes.count) return;
  const detach = routes.detach;
  routes.detach = undefined;
  detach?.();
}
function dispatchOwnWrite(
  unit: SharedUnit,
  routes: OwnWriteRoutes,
  key: Scope,
  route: OwnWriteRoute,
  value: unknown,
  scope: Scope,
): void {
  for (const subscription of route instanceof Set ? [...route] : [route]) {
    // A recycled instance scope may now belong to another instance.
    if (!isOwnWrite(subscription.internal, scope)) {
      if (!subscription.internal.alive && dropOwnWrite(routes, key, subscription))
        releaseOwnWriteRoute(routes);
      continue;
    }
    try {
      subscription.listener(value, scope);
    } catch (error) {
      reportContainedError(error, { kind: "store subscriber", subject: describeNode(unit.node) });
    }
  }
}

export function generateId(): string {
  idCounter += 1;

  return `~tmp${idCounter}`;
}

/** First frame outside this package's own dispose plumbing — the culprit. */
function formatDisposeSite(stack: string | undefined): string | undefined {
  if (!stack) return undefined;

  for (const line of stack.split("\n").slice(1)) {
    const frame = line.trim();

    if (!frame.startsWith("at ")) continue;

    if (
      frame.includes("models/collection") ||
      frame.includes("models/definition") ||
      frame.includes("models/union") ||
      frame.includes("disposeInstance")
    ) {
      continue;
    }

    return frame.slice(3);
  }

  return undefined;
}

/** §10.4: attach an external cleanup (a socket, a marker, an unsubscribe) to
 * the INSTANCE's lifetime. Runs at dispose while fields are still readable. */
export function registerInstanceCleanup(
  internal: InstanceInternal,
  cleanup: () => void,
): () => void {
  requireAlive(internal);
  (internal.disposers ??= new Set()).add(cleanup);

  return () => {
    internal.disposers?.delete(cleanup);
  };
}

/** Disposal must complete: a failing cleanup is reported, not propagated. */
export function runInstanceDisposers(internal: InstanceInternal): void {
  if (!internal.disposers) return;

  for (const cleanup of [...internal.disposers]) {
    try {
      cleanup();
    } catch (error) {
      if (typeof console !== "undefined") {
        // eslint-disable-next-line no-console
        console.error("[models] onCleanup handler failed:", error);
      }
    }
  }

  internal.disposers.clear();
}

function requireAlive(internal: InstanceInternal): void {
  if (!internal.alive) {
    // §3.5: the throw fires in an innocent read — it carries the dispose site,
    // or the evidence about the culprit is gone with the instance.
    const site = formatDisposeSite(internal.disposedSite?.stack);

    throw new Error(`[models] entity was disposed${site ? ` — disposed at ${site}` : ""}`);
  }
}

function fieldStoreFor(internal: InstanceInternal, name: string): StoreWritable<unknown> {
  const runtime = internal.runtimeDefinition.fields.get(name);

  if (!runtime) throw new Error(`[models] unknown field "${name}"`);

  return internal.runtimeDefinition.kind === "static"
    ? (runtime.staticStore as StoreWritable<unknown>)
    : (internal.ownStores!.get(name) as StoreWritable<unknown>);
}

export function taskOwnerOf(internal: InstanceInternal): Owner {
  if (internal.taskOwner) return internal.taskOwner;
  const owner = (internal.taskOwner = new ModelTaskOwner());
  if (!internal.alive) owner.dispose();
  return owner;
}

function runInInstance<T>(internal: InstanceInternal, fn: () => T, owned = false): T {
  const scope = internal.scope ?? internal.parentScope;

  return withOwner(owned ? taskOwnerOf(internal) : (internal.taskOwner ?? getOwner()), () =>
    runScopeTask(scope, fn),
  );
}

/** Collection-side access to the instance context and relation backing stores. */
export function runInInstanceContext<T>(internal: InstanceInternal, fn: () => T): T {
  return runInInstance(internal, fn);
}

export function relationStoreFor(internal: InstanceInternal, name: string): StoreWritable<unknown> {
  const runtime = internal.runtimeDefinition.relations.get(name);

  if (!runtime) throw new Error(`[models] unknown relation "${name}"`);

  return internal.runtimeDefinition.kind === "static"
    ? (runtime.staticStore as StoreWritable<unknown>)
    : (internal.ownStores!.get(name) as StoreWritable<unknown>);
}

const relationReadSources = new WeakMap<InstanceInternal, Map<string, ModelFieldReadSource>>();
const relationBridges = new WeakMap<InstanceInternal, Map<string, () => void>>();
// A reader that tracked a bridge may also hold a global edge to it once it is
// observed scope-lessly; like a store write, one bridge notification reaches
// each dependent once per drain.
const readBridgeBatch = Symbol("virentia.modelReadBridge");

/** One data unit may be read from several model scopes. Fan out dependency
 * invalidation to those reader scopes without moving its actual state. */
function readBridge(
  internal: InstanceInternal,
  unit: {
    readonly node: Node;
    subscribe(fn: (value: unknown, scope: Scope) => void): () => void;
  },
): () => void {
  let changed: Node | undefined;
  let readers: Set<WeakRef<Scope>> | undefined;
  let known: WeakSet<Scope> | undefined;
  let weakInternal: WeakRef<InstanceInternal> | undefined;
  let detach: (() => void) | undefined;
  return () => {
    const active = getActiveScope();
    if (!active || !isTracking()) return;
    const scope = unwrapMicroScope(active);
    // A view/computed already executing in this model's scope can observe the
    // native graph directly. A global store subscriber per displayed instance
    // otherwise fans every write out to every row of a staticModel table.
    if (scope === (internal.scope ?? internal.parentScope)) {
      trackNode(unit.node);
      return;
    }
    changed ??= node();
    readers ??= new Set();
    known ??= new WeakSet();
    weakInternal ??= new WeakRef(internal);
    // A computed's dependency discovery reads in a throwaway scope: it needs the
    // edge to `changed`, but forwarding writes there would run the computed and
    // its observers once more per write.
    if (!known.has(scope) && !isBootstrapScope(scope)) {
      known.add(scope);
      readers.add(new WeakRef(scope));
    }
    trackNode(changed);
    if (!detach) {
      detach = withOwner(taskOwnerOf(internal), () =>
        subscribeOwnWrites(internal, unit, (value) => {
          const current = weakInternal!.deref();
          if (!current) {
            detach?.();
            readers!.clear();
            return;
          }
          for (const reference of readers!) {
            const reader = reference.deref();
            if (!reader) {
              readers!.delete(reference);
              continue;
            }
            runDetached({
              unit: changed!,
              payload: value,
              scope: reader,
              batchKey: readBridgeBatch,
            });
          }
        }),
      );
      internal.taskOwner?.onCleanup(() => {
        detach?.();
        readers!.clear();
      });
    }
  };
}

/** Cross-instance bindings must subscribe to a relation's instance, not its shared static node. */
export function readRelationStore(internal: InstanceInternal, name: string): unknown {
  const unit = relationStoreFor(internal, name);
  let bridges = relationBridges.get(internal);
  if (!bridges) relationBridges.set(internal, (bridges = new Map()));
  let bridge = bridges.get(name);
  if (!bridge) bridges.set(name, (bridge = readBridge(internal, unit)));
  bridge();
  let sources = relationReadSources.get(internal);
  if (!sources) relationReadSources.set(internal, (sources = new Map()));
  let source = sources.get(name);
  if (!source) {
    source = {
      subscribe(listener) {
        return subscribeOwnWrites(internal, unit, () => listener());
      },
    };
    sources.set(name, source);
  }
  trackModelFieldRead(source);
  // The bridge registered this read's dependency; see FieldFacade.value.
  return untrackedRead(() => runInInstance(internal, () => unit.value));
}

/** Native unit metadata is shared, while customized store nodes retain a local source. */
type FieldFacadeSource = NativeStoreState | {
  readonly unit: StoreWritable<unknown>;
  readonly node: Node;
  readonly id?: undefined;
};

/** Shared field accessors; only subscriptions and foreign reads need closures. */
class FieldFacade {
  writable = true as const;
  readonly #internal: InstanceInternal;
  readonly #source: FieldFacadeSource;
  readonly #name: string | undefined;
  // Position in a light instance's field seed; -1 when reads must use the scope.
  readonly #seed: number;
  #track?: () => void;
  #subscribe?: (fn: (value: unknown, scope: Scope) => void) => () => void;
  constructor(internal: InstanceInternal, name: string, unit: StoreWritable<unknown>) {
    this.#internal = internal;
    this.#name = internal.registry && !internal.registry.indexes.has(name) ? undefined : name;
    const node = unit.node;
    const native = nativeStoreStateOf(unit);
    if (native && native.node === node && !node.resolveScope) {
      native.api ??= nativeStoreApiOf(unit);
      this.#source = native;
    } else this.#source = { unit, node };
    this.#seed =
      this.#source.id !== undefined ? fieldSeedIndex(internal.runtimeDefinition, name) : -1;
  }
  get value(): unknown {
    const internal = this.#internal,
      source = this.#source,
      unit = source.unit;
    requireAlive(internal);
    // A light instance answers untracked native reads from its seed: nothing
    // has written the field, and nobody needs its scope yet.
    const seed = internal.fieldSeed;
    if (
      seed !== undefined &&
      this.#seed >= 0 &&
      source.id !== undefined &&
      !source.node.resolveScope &&
      readsValueNatively(source.api!) &&
      !isTracking()
    ) {
      const value = seed[this.#seed];
      if (
        value === null ||
        (typeof value !== "object" && typeof value !== "function") ||
        !("then" in value)
      ) {
        trackModelFieldRead(this);
        return value;
      }
    }
    const active = getActiveScope();
    const home = internal.scope ?? internal.parentScope;
    const local = active === home || (active && unwrapMicroScope(active) === home);
    const native = source.id === undefined ? undefined : source;
    const direct = native && !source.node.resolveScope && readsValueNatively(native.api!);
    const bridged = !local && active !== null && isTracking();
    if (bridged) (this.#track ??= readBridge(internal, unit))();
    trackModelFieldRead(this);
    if (local) {
      if (direct) {
        trackNode(source.node);
        return readModelStoreState(
          home,
          native,
          native.snapshot && internal.scope ? internal.parentScope : undefined,
        );
      }
      return unit.value;
    }
    // A foreign read. When tracked it depends on the bridge above, so the
    // home-scope read itself must not reach the caller's collector: an observed
    // computed would promote the shared field node to a global edge, then re-run
    // (and notify) in the home scope of every instance whose field is written.
    if (direct) {
      const value = readModelStoreState(
        home,
        native,
        native.snapshot && internal.scope ? internal.parentScope : undefined,
      );
      if (
        value === null ||
        (typeof value !== "object" && typeof value !== "function") ||
        !("then" in value)
      )
        return value;
    }
    return bridged
      ? untrackedRead(() => runInInstance(internal, () => unit.value))
      : runInInstance(internal, () => unit.value);
  }
  set value(next: unknown) {
    const internal = this.#internal,
      unit = this.#source.unit;
    requireAlive(internal);
    const previousScope = setActiveScope(internal.scope ?? internal.parentScope);
    const previousOwner = setOwner(internal.taskOwner ?? getOwner());
    try {
      unit.value = next;
    } finally {
      setOwner(previousOwner);
      setActiveScope(previousScope);
    }
    if (this.#name !== undefined) internal.onWrite?.(this.#name, next);
  }
  get node(): Node {
    return this.#source.node;
  }
  [fixedScopedStoreNode](scope: Scope): Node | undefined {
    const source = this.#source;
    return scope === (this.#internal.scope ?? this.#internal.parentScope) &&
      source.id !== undefined &&
      !source.node.resolveScope &&
      readsValueNatively(source.api!)
      ? source.node
      : undefined;
  }
  get subscribe(): (fn: (value: unknown, scope: Scope) => void) => () => void {
    return (this.#subscribe ??= bindStoreSubscription(
      (fn) => subscribeOwnWrites(this.#internal, this.#source.unit, fn),
      this.#internal.scope ?? this.#internal.parentScope,
    ));
  }
  get [boundStoreAlive](): boolean { return this.#internal.alive; }
}

const fieldSeedIndexes = new WeakMap<ModelDefinition, ReadonlyMap<string, number>>();
/** A static field's position in a light instance's seed: the definition's field order. */
function fieldSeedIndex(definition: ModelDefinition, name: string): number {
  if (definition.kind !== "static" || definition["~singletonOf"]) return -1;
  let indexes = fieldSeedIndexes.get(definition);
  if (!indexes) {
    indexes = new Map(Array.from(definition.fields.keys(), (field, index) => [field, index]));
    fieldSeedIndexes.set(definition, indexes);
  }
  return indexes.get(name) ?? -1;
}

/** The per-field facade on the instance: the same store surface as `self.x` in setup (§8). */
function createFieldFacade(
  internal: InstanceInternal,
  name: string,
  runtime: FieldRuntime,
): object {
  const storeUnit =
    internal.runtimeDefinition.kind === "static"
      ? (runtime.staticStore as StoreWritable<unknown>)
      : internal.ownStores!.get(name)!;
  const facade = new FieldFacade(internal, name, storeUnit);

  // A singleton exposes native store methods as well as the scoped field view.
  // Framework readers bind `.value`, but must not erase `.map`/`.filter`.
  if (internal.runtimeDefinition["~singletonOf"]) {
    const fixedNode = facade[fixedScopedStoreNode].bind(facade);
    return new Proxy(storeUnit, {
      get(target, key, receiver) {
        if (key === fixedScopedStoreNode) return fixedNode;
        return key in facade ? Reflect.get(facade, key) : Reflect.get(target, key, receiver);
      },
      set(target, key, value, receiver) {
        if (key === "value") {
          facade.value = value;
          return true;
        }
        return Reflect.set(target, key, value, receiver);
      },
    });
  }

  return facade;
}

function memberOf(internal: InstanceInternal, name: string): unknown {
  const members =
    internal.runtimeDefinition.kind === "static"
      ? internal.runtimeDefinition.staticMembers
      : internal.ownMembers;

  return members?.get(name);
}

function isStoreLike(value: unknown): value is { value: unknown; node: never; subscribe: never } {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    "node" in (value as object) &&
    "subscribe" in (value as object)
  );
}

interface StoreMember {
  readonly value: unknown;
  readonly node: Node;
  subscribe(listener: (value: unknown, scope: Scope) => void): () => void;
}

/** Shared accessors replace the per-instance computed/store getter closures. */
class MemberStoreFacade
  extends DeferredOwner
  implements ModelFieldReadSource, ProxyHandler<object>
{
  readonly #internal: InstanceInternal;
  readonly #unit: StoreMember;
  readonly #reader: ReturnType<typeof nativeModelStoreInfoOf>;
  #track?: () => void;
  #subscribe?: StoreMember["subscribe"];
  #fixedNode?: (scope: Scope) => Node | undefined;
  constructor(
    internal: InstanceInternal,
    unit: StoreMember,
    reader?: ReturnType<typeof nativeModelStoreInfoOf>,
  ) {
    super();
    this.#internal = internal;
    this.#unit = unit;
    this.#reader = reader?.reactive ? undefined : reader;
  }
  /** The node `read` tracks for a reader in the instance's own scope. */
  static fixedNode(facade: MemberStoreFacade): (scope: Scope) => Node | undefined {
    return (facade.#fixedNode ??= (scope) =>
      scope === (facade.#internal.scope ?? facade.#internal.parentScope)
        ? facade.#unit.node
        : undefined);
  }
  resolveOwner(): Owner {
    return taskOwnerOf(this.#internal);
  }
  get value(): unknown {
    return MemberStoreFacade.read(this);
  }
  static read(facade: MemberStoreFacade): unknown {
    const internal = facade.#internal;
    requireAlive(internal);
    const active = getActiveScope();
    const home = internal.scope ?? internal.parentScope;
    let bridged = false;
    if (active && isTracking()) {
      if (active === home || unwrapMicroScope(active) === home) trackNode(facade.#unit.node);
      else {
        (facade.#track ??= readBridge(internal, facade.#unit))();
        bridged = true;
      }
    }
    trackModelFieldRead(facade);
    const previousOwner = setOwner(internal.taskOwner ?? facade);
    try {
      // See FieldFacade.value: a bridged read must not also track the shared node.
      return bridged
        ? untrackedRead(() => readScopeTaskValue(home, facade.#unit, facade.#reader))
        : readScopeTaskValue(home, facade.#unit, facade.#reader);
    } finally {
      setOwner(previousOwner);
    }
  }
  get node(): Node {
    return this.#unit.node;
  }
  get __proto__(): object {
    return Object.prototype;
  }
  getPrototypeOf(): object | null {
    return apiPrototypeOf(this.#unit);
  }
  get subscribe(): StoreMember["subscribe"] {
    return (this.#subscribe ??= bindStoreSubscription(
      (listener) => subscribeOwnWrites(this.#internal, this.#unit, listener),
      this.#internal.scope ?? this.#internal.parentScope,
    ));
  }
  get(target: object, key: PropertyKey, receiver: unknown): unknown {
    if (key === "value") return MemberStoreFacade.read(this);
    if (key === "node") return this.node;
    if (key === boundStoreAlive) return this.#internal.alive;
    if (key === fixedScopedStoreNode) return MemberStoreFacade.fixedNode(this);
    if (key === "subscribe") return this.subscribe;
    if (key === "constructor") return Object;
    if (key === "__proto__") return Object.prototype;
    if (key in Object.prototype) return Reflect.get(Object.prototype, key);
    if (key === sequenceBinding) {
      const binding = runInInstance(this.#internal, () => Reflect.get(this.#unit, key));
      return binding && { ...binding, scope: this.#internal.parentScope };
    }
    return Reflect.get(this.#unit, key, receiver);
  }
  set(target: object, key: PropertyKey, value: unknown): boolean {
    if (key !== "value") return Reflect.set(this.#unit, key, value);
    requireAlive(this.#internal);
    runInInstance(this.#internal, () => Reflect.set(this.#unit, key, value));
    return true;
  }
  has(_target: object, key: PropertyKey): boolean {
    return Reflect.has(this.#unit, key);
  }
  ownKeys(): (string | symbol)[] {
    return Reflect.ownKeys(this.#unit);
  }
  getOwnPropertyDescriptor(_target: object, key: PropertyKey): PropertyDescriptor | undefined {
    return Reflect.getOwnPropertyDescriptor(this.#unit, key);
  }
  defineProperty(_target: object, key: PropertyKey, descriptor: PropertyDescriptor): boolean {
    return Reflect.defineProperty(this.#unit, key, descriptor);
  }
  deleteProperty(_target: object, key: PropertyKey): boolean {
    return Reflect.deleteProperty(this.#unit, key);
  }
}

function wrapMember(internal: InstanceInternal, member: unknown): unknown {
  const value = modelValueBindingOf(member);
  if (value) return value.bind(new InstanceValueContext(internal));
  return wrapNativeMember(internal, member);
}

registerModelValueScopeBinder((value, scope) => {
  const internal = instanceOfScope(unwrapMicroScope(scope));
  return internal ? wrapMember(internal, value) as object : value;
});

class InstanceValueContext implements ModelValueContext {
  constructor(readonly internal: InstanceInternal) {}
  get instance(): ModelInstanceBinding { return instanceBindingOf(this.internal); }
  bind<T>(value: T): T { return wrapMember(this.internal, value) as T; }
  native<T>(value: T): T { return wrapNativeMember(this.internal, value) as T; }
}

function wrapNativeMember(internal: InstanceInternal, member: unknown): unknown {
  // A computed (or any store-surfaced unit) returned from setup must read in
  // the INSTANCE scope, not the caller's — otherwise it evaluates against the
  // shared declaration defaults and caches into the wrong scope.
  const native = nativeModelStoreInfoOf(member);
  if (native || isStoreLike(member)) {
    return new Proxy(
      native?.api ?? (member as object),
      new MemberStoreFacade(internal, member as StoreMember, native),
    );
  }

  if (typeof member !== "function") return member;

  if ("node" in member && !("pending" in member)) {
    return bindEventToScope(
      member as EventCallable<unknown>,
      internal.scope ?? internal.parentScope,
      () => requireAlive(internal),
      taskOwnerOf(internal),
    );
  }

  return new Proxy(member, new MemberFunctionFacade(internal));
}

// Shared traps avoid one apply closure per function handle. Unit properties
// remain lazy: a model does not allocate all of an effect's lifecycle views.
class MemberFunctionFacade implements ProxyHandler<(...args: any[]) => unknown> {
  #members?: Map<PropertyKey, unknown>;
  #event?: EventCallable<unknown>;
  constructor(readonly internal: InstanceInternal) {}
  apply(target: (...args: any[]) => unknown, thisArg: unknown, args: any[]): unknown {
    requireAlive(this.internal);
    return runInInstance(this.internal, () => Reflect.apply(target, thisArg, args), true);
  }
  get(target: (...args: any[]) => unknown, key: PropertyKey, receiver: unknown): unknown {
    if (key === boundScopeKey) return this.internal.scope ?? this.internal.parentScope;
    if (key === "node") return Reflect.get(target, key);
    if (this.#members?.has(key)) return this.#members.get(key);
    if ("node" in target && !("pending" in target) &&
        (key === "map" || key === "filter" || key === "filterMap")) {
      const event = this.#event ??= bindEventToScope(target as EventCallable<unknown>,
        this.internal.scope ?? this.internal.parentScope,
        () => requireAlive(this.internal), taskOwnerOf(this.internal));
      const method = (Reflect.get(event, key, event) as Function).bind(event);
      (this.#members ??= new Map()).set(key, method);
      return method;
    }
    const value = Reflect.get(target, key, receiver);
    if (!value || (typeof value !== "object" && typeof value !== "function") || !("node" in value)) return value;
    // abort is a callable implementation, not just its notification node.
    const bound = key === "abort" && "pending" in target && typeof value === "function"
      ? new Proxy(value, new MemberFunctionFacade(this.internal))
      : wrapMember(this.internal, value);
    (this.#members ??= new Map()).set(key, bound);
    return bound;
  }
}

class SetupContext implements ModelSetupContext {
  private ordinal = 0;
  constructor(readonly kind: ModelKind) {}
  nextKey(prefix: string): string { return `${prefix}:${this.ordinal++}`; }
}

function memberInitializers(members: ReadonlyMap<string, unknown>): readonly NonNullable<ReturnType<typeof modelValueBindingOf>>[] {
  const values = new Set<NonNullable<ReturnType<typeof modelValueBindingOf>>>();
  for (const member of members.values()) {
    const binding = modelValueBindingOf(member);
    if (binding?.initialize) values.add(binding);
  }
  return [...values];
}

function withMemberInitialization(members: ReadonlyMap<string, unknown>, onCreate: ModelConfig["onCreate"]): ModelConfig["onCreate"] {
  const initializers = memberInitializers(members);
  if (!initializers.length) return onCreate;
  return (self: never) => {
    const result = (onCreate as ((self: object) => unknown) | undefined)?.(self);
    if (result && typeof (result as PromiseLike<unknown>).then === "function") return result;
    const context = new InstanceValueContext(instanceInternalOf(self)!);
    for (const binding of initializers) binding.initialize!(context);
  };
}

/** Dynamic setups have their own API objects and initializer set per instance. */
export function initializeDynamicModelValues(internal: InstanceInternal): void {
  const members = internal.ownMembers;
  if (!members) return;
  const values = memberInitializers(members);
  if (!values.length) return;
  runInInstance(internal, () => {
    const context = new InstanceValueContext(internal);
    for (const value of values) value.initialize!(context);
  }, true);
}

// ---------------------------------------------------------------------------
// Direct members (see `DirectModelMember`): what `wrapMember` and
// `createFieldFacade` hand out, read or called in place. Each covers its
// facade's own-scope path; anything else uses the facade, created on demand.

abstract class DirectMember implements DirectModelMember {
  abstract readonly kind: 0 | 1 | 2;
  abstract readonly node: Node;
  constructor(readonly name: string) {}
  facade(instance: object): unknown {
    return ((instance as InstanceInternal).facade as Record<string, unknown>)[this.name];
  }
  read(instance: object): unknown {
    return (this.facade(instance) as { value: unknown }).value;
  }
  call(instance: object, payload: unknown): unknown {
    return (this.facade(instance) as (payload: unknown) => unknown)(payload);
  }
  access(_instance: object): void {}
  fixedNode(_instance: object, _scope: Scope): Node | undefined {
    return undefined;
  }
}

/** `FieldFacade.value` for a reader in the instance's own scope. */
class DirectField extends DirectMember {
  readonly kind = 0 as const;
  readonly node: Node;
  readonly #unit: StoreWritable<unknown>;
  readonly #native: NativeStoreState;
  constructor(name: string, unit: StoreWritable<unknown>, native: NativeStoreState) {
    super(name);
    this.#unit = unit;
    this.#native = native;
    this.node = native.node;
  }
  /** As `FieldFacade`'s `fixedScopedStoreNode`. */
  override fixedNode(instance: object, scope: Scope): Node | undefined {
    const internal = instance as InstanceInternal;
    const native = this.#native;
    return scope === (internal.scope ?? internal.parentScope) &&
      !native.node.resolveScope &&
      readsValueNatively(native.api!)
      ? native.node
      : undefined;
  }
  override read(instance: object): unknown {
    const internal = instance as InstanceInternal;
    requireAlive(internal);
    const active = getActiveScope();
    const home = internal.scope ?? internal.parentScope;
    // A collector receives the facade itself; another scope reads through it.
    if (
      modelFieldReadCollector ||
      (active !== home && !(active && unwrapMicroScope(active) === home))
    )
      return super.read(instance);
    const native = this.#native;
    if (!native.node.resolveScope && readsValueNatively(native.api!)) {
      trackNode(native.node);
      return readModelStoreState(
        home,
        native,
        native.snapshot && internal.scope ? internal.parentScope : undefined,
      );
    }
    return this.#unit.value;
  }
}

/** `MemberStoreFacade.read` in the instance's own scope, once its task owner exists. */
class DirectStore extends DirectMember {
  readonly kind = 1 as const;
  readonly node: Node;
  readonly #unit: StoreMember;
  readonly #reader: ReturnType<typeof nativeModelStoreInfoOf>;
  constructor(name: string, unit: StoreMember, reader: ReturnType<typeof nativeModelStoreInfoOf>) {
    super(name);
    this.#unit = unit;
    this.#reader = reader;
    this.node = unit.node;
  }
  /** As `MemberStoreFacade.fixedNode`. */
  override fixedNode(instance: object, scope: Scope): Node | undefined {
    const internal = instance as InstanceInternal;
    return scope === (internal.scope ?? internal.parentScope) ? this.#unit.node : undefined;
  }
  override read(instance: object): unknown {
    const internal = instance as InstanceInternal;
    requireAlive(internal);
    const active = getActiveScope();
    const home = internal.scope ?? internal.parentScope;
    // Without a task owner the facade itself is the read's owner.
    const owner = internal.taskOwner;
    if (
      !owner ||
      modelFieldReadCollector ||
      (active !== home && !(active && unwrapMicroScope(active) === home))
    )
      return super.read(instance);
    if (active && isTracking()) trackNode(this.#unit.node);
    const previousOwner = setOwner(owner);
    try {
      return readScopeTaskValue(home, this.#unit, this.#reader);
    } finally {
      setOwner(previousOwner);
    }
  }
}

/** What the bound callable `wrapMember` makes of an event or action does. */
class DirectEvent extends DirectMember {
  readonly kind = 2 as const;
  readonly node: Node;
  constructor(name: string, unit: EventCallable<unknown>) {
    super(name);
    this.node = unit.node;
  }
  /** `wrapMember` takes the instance's task owner as it binds the member. */
  override access(instance: object): void {
    taskOwnerOf(instance as InstanceInternal);
  }
  override call(instance: object, payload: unknown): unknown {
    const internal = instance as InstanceInternal;
    requireAlive(internal);
    const ambient = getActiveScope();
    const caller = getOwner();
    const previousOwner = setOwner(taskOwnerOf(internal));
    try {
      return runUnitScoped(
        this.node,
        unwrapMicroScope(internal.scope ?? internal.parentScope),
        payload,
        ambient,
        caller,
      );
    } finally {
      setOwner(previousOwner);
    }
  }
}

function createDirectMember(
  name: string,
  entry: Exclude<InstanceFacadePlan[string], undefined>,
): DirectMember | null {
  if (entry.kind === "field") {
    const unit = entry.runtime.staticStore;
    if (!unit) return null;
    const node = unit.node;
    const native = nativeStoreStateOf(unit);
    if (!native || native.node !== node || node.resolveScope) return null;
    native.api ??= nativeStoreApiOf(unit);
    return new DirectField(name, unit, native);
  }
  if (entry.kind !== "member") return null;
  const member = entry.value;
  const native = nativeModelStoreInfoOf(member);
  if (native) return native.reactive ? null : new DirectStore(name, member as StoreMember, native);
  // A view bound to a scope already is bound (or refused) by its facade.
  if (
    typeof member === "function" &&
    "node" in member &&
    !("pending" in member) &&
    !isStoreLike(member) &&
    boundEventScopeOf(member) === undefined
  )
    return new DirectEvent(name, member as EventCallable<unknown>);
  return null;
}

/** See `directModelMemberOf` in ./bindings. */
function resolveDirectMember(binding: object, name: string): DirectModelMember | undefined {
  const internal = binding as InstanceInternal;
  const base = internal.facadeTarget;
  // A native static instance is its own binding (`instanceBindingOf`); its
  // facade's target names it.
  if (base === undefined || InstanceTarget.rawState(base) !== internal) return undefined;
  // The proxy's own and API properties win over members, as in its `get`.
  if (name === "then" || name === "id" || name in base) return undefined;
  const entry = internal.registry?.facade?.[name];
  if (!entry) return undefined;
  let member = entry.direct;
  if (member === undefined) {
    const definition = internal.runtimeDefinition;
    member = (entry as { direct: DirectModelMember | null }).direct =
      definition.kind === "static" && !definition["~singletonOf"]
        ? createDirectMember(name, entry)
        : null;
  }
  return member ?? undefined;
}
registerDirectModelMembers(resolveDirectMember);

/** @internal Native static instances can implement the renderer protocol themselves. */
export function beforeDisposeInstance(
  internal: InstanceInternal,
  callback: () => void | PromiseLike<unknown>,
): () => void {
  addDisposalParticipant(internal, callback);
  return () => removeDisposalParticipant(internal, callback);
}

export function addDisposalParticipant(
  internal: InstanceInternal,
  callback: ModelBeforeDisposer,
): void {
  requireAlive(internal);
  const current = internal.beforeDisposers;
  if (!current) internal.beforeDisposers = callback;
  else if (!(current instanceof Set)) {
    if (current !== callback) internal.beforeDisposers = new Set([current, callback]);
  } else current.add(callback);
}

export function removeDisposalParticipant(
  internal: InstanceInternal,
  callback: ModelBeforeDisposer,
): void {
  if (internal.beforeDisposers === callback) internal.beforeDisposers = undefined;
  else if (internal.beforeDisposers instanceof Set) internal.beforeDisposers.delete(callback);
}

/** @internal Shared adoption rules for native and dynamic renderer bindings. */
export function adoptInstanceChild(internal: InstanceInternal, child: object): void {
  const target = instanceInternalOf(child);
  if (!target || target.parentScope !== internal.parentScope)
    throw new Error("[models] Adopted children must belong to the same application scope");
  if (target.owningInstance && target.owningInstance !== internal)
    throw new Error("[models] Instance already has an owning parent");
  target.owningInstance = internal;
  (internal.ownedInstances ??= new Set()).add(target);
}

class InstanceBinding implements ModelInstanceBinding {
  readonly scope: Scope;
  readonly homeScope: Scope;
  readonly definition: ModelDefinition;
  readonly #internal: InstanceInternal;
  constructor(internal: InstanceInternal) {
    this.#internal = internal;
    this.scope = internal.scope ?? internal.parentScope;
    this.homeScope = internal.parentScope;
    this.definition = publicOf(internal.runtimeDefinition);
  }
  get identity(): string {
    return this.#internal.snapshotKey ?? this.#internal.key;
  }
  get props(): Readonly<Record<string, unknown>> {
    return this.#internal.props ?? {};
  }
  getData(key: symbol): ModelBindingData | undefined {
    return getInstanceData(this.#internal, key);
  }
  setData(data: ModelBindingData): void {
    setInstanceData(this.#internal, data);
  }
  deleteData(key: symbol): void {
    deleteInstanceData(this.#internal, key);
  }
  disposeWithTrace(trace: ModelDisposalTrace): void | Promise<void> {
    return disposeInstanceForBinding(this.#internal, trace);
  }
  beforeDispose(callback: () => void | PromiseLike<unknown>): () => void {
    return beforeDisposeInstance(this.#internal, callback);
  }
  addDisposalParticipant(participant: ModelDisposalParticipant): void {
    addDisposalParticipant(this.#internal, participant);
  }
  removeDisposalParticipant(participant: ModelDisposalParticipant): void {
    removeDisposalParticipant(this.#internal, participant);
  }
  adopt(child: object): void {
    adoptInstanceChild(this.#internal, child);
  }
  createOwned(definition: ModelDefinition, props: Record<string, unknown>): object {
    const internal = this.#internal;
    requireAlive(internal);
    if (!internal.createOwned) throw new Error("[models] Owned creation is unavailable");
    return internal.createOwned(definition, props);
  }
  subscribe(listener: () => void): () => void {
    return this.#internal.subscribeSelf?.(listener) ?? (() => {});
  }
}

const instanceApi = {
  get id(): string {
    return instanceThisInternal(this).id;
  },

  get key(): string {
    return instanceThisInternal(this).key;
  },

  get alive(): boolean {
    // never throws — the whole point is degrading without a try (§3.5); the
    // hook makes the read reactive by tracking the collection epoch
    const internal = instanceThisInternal(this);
    internal.onAliveRead?.();

    return internal.alive;
  },

  json(): Record<string, unknown> {
    const internal = instanceThisInternal(this);
    requireAlive(internal);

    return serializeInstance(internal);
  },

  toJSON(): Record<string, unknown> {
    return this.json();
  },

  dispose(): void | Promise<void> {
    const internal = instanceThisInternal(this);
    if (!internal.alive) return;

    return internal.onDispose?.(internal);
  },

  onCleanup(cleanup: () => void): () => void {
    return registerInstanceCleanup(instanceThisInternal(this), cleanup);
  },

  rebind(newId: string): void {
    const internal = instanceThisInternal(this);
    requireAlive(internal);

    const oldId = internal.id;

    if (oldId === newId) return;

    internal.onBeforeRebind?.(newId);
    internal.id = newId;
    internal.temporaryId = false;
    internal.onRebind?.(oldId, newId);
  },
};

function instanceThisInternal(receiver: object): InstanceInternal {
  return InstanceTarget.rawState(receiver) ?? instanceInternalOf(receiver)!;
}
const instanceTargetPrototype = InstanceTarget.prototype;
// An instance's target, facades and binding die with it: keep their hidden
// classes (see kernel/shapes.ts).
{
  const internal = { registry: undefined, scope: undefined, parentScope: undefined } as never;
  const unit = { node: {} } as never;
  retainShapes(
    "core/models/facades",
    new InstanceTarget(internal),
    new FieldFacade(internal, "", unit),
    new MemberStoreFacade(internal, unit),
    new InstanceBinding({ ...(internal as object), runtimeDefinition: {} } as never),
  );
}

/** Native renderer disposal must still honour customized public dispose methods. */
export function disposeInstanceForBinding(
  internal: InstanceInternal,
  trace: ModelDisposalTrace,
): void | Promise<void> {
  if (!internal.alive) return;
  const facade = internal.facade!;
  const target = (facade as Record<symbol, object>)[instanceTargetKey];
  if (
    Reflect.getPrototypeOf(target) === instanceTargetPrototype &&
    !Object.hasOwn(target, "dispose")
  )
    return internal.onDispose?.(internal, trace);
  return (facade as { dispose(): void | Promise<void> }).dispose();
}

const instanceDescriptors = Object.getOwnPropertyDescriptors(instanceApi);
Object.defineProperties(instanceTargetPrototype, instanceDescriptors);
Object.defineProperty(instanceTargetPrototype, "constructor", {
  value: Object,
  writable: true,
  configurable: true,
});
const instanceBindings = new WeakMap<InstanceInternal, ModelInstanceBinding>();
const detachableMethods = new Map<string, Function>([
  ["json", instanceApi.json],
  ["dispose", instanceApi.dispose],
  ["onCleanup", instanceApi.onCleanup],
  ["rebind", instanceApi.rebind],
]);
const instanceBindingDescriptor: PropertyDescriptor = {
  get(this: object) {
    return instanceBindingOf(instanceThisInternal(this));
  },
};

function instanceBindingOf(internal: InstanceInternal): ModelInstanceBinding {
  const definition = internal.runtimeDefinition;
  if (definition.kind === "static" && !definition["~singletonOf"] && "beforeDispose" in internal)
    return internal as unknown as ModelInstanceBinding;
  let binding = instanceBindings.get(internal);
  if (!binding) instanceBindings.set(internal, (binding = new InstanceBinding(internal)));
  return binding;
}

function ownInstanceDescriptor(base: object, descriptor: PropertyDescriptor): PropertyDescriptor {
  return descriptor.get ? { ...descriptor, get: descriptor.get.bind(base) } : { ...descriptor };
}

function materializeInstanceApi(base: object): void {
  if (Reflect.getPrototypeOf(base) !== instanceTargetPrototype) return;
  for (const key of Object.keys(instanceDescriptors)) {
    if (!Object.hasOwn(base, key))
      Object.defineProperty(
        base,
        key,
        ownInstanceDescriptor(base, instanceDescriptors[key as keyof typeof instanceDescriptors]),
      );
  }
  if (!Object.hasOwn(base, modelInstanceBinding))
    Object.defineProperty(
      base,
      modelInstanceBinding,
      ownInstanceDescriptor(base, instanceBindingDescriptor),
    );
  Reflect.setPrototypeOf(base, Object.prototype);
}

/** Detachable methods cached on their instance: still the native implementations. */
const nativeBoundMethods = new WeakSet<Function>();

function boundInstanceMethod(base: object, property: string, value: unknown): unknown {
  const method = detachableMethods.get(property);
  if (!method || method !== value) return value;
  const bound = (value as Function).bind(base);
  nativeBoundMethods.add(bound);
  Reflect.set(base, property, bound);
  return bound;
}

/** The instance's `json()` is the native serializer: its API was not materialized or replaced. */
function hasNativeJson(base: object): boolean {
  if (Reflect.getPrototypeOf(base) !== instanceTargetPrototype) return false;
  // `json` read once is cached on the instance as a bound method.
  return !Object.hasOwn(base, "json") || nativeBoundMethods.has((base as { json: Function }).json);
}

function instanceSymbol(base: object, property: symbol, receiver: unknown): unknown {
  if (property === instanceTargetKey) return base;
  if (property === modelInstanceBinding) return instanceBindingOf(InstanceTarget.state(base));
  if (
    property === modelViewSnapshot ||
    property === modelDefaultViewSnapshot ||
    property === modelViewCapture
  ) {
    if (!hasNativeJson(base)) return;
    const internal = InstanceTarget.state(base);
    requireAlive(internal);
    return property === modelViewSnapshot
      ? serializeInstance(internal)
      : property === modelDefaultViewSnapshot
        ? captureDefaultView(internal)
        : new LiveViewCapture(internal);
  }
  return Reflect.get(base, property, receiver);
}

/** Keep metadata resolution off the hot cached-handle path. */
function uncachedInstanceMember(internal: InstanceInternal, property: string): unknown {
  const plan = internal.registry?.facade;
  if (plan) {
    const entry = plan[property];
    if (!entry) return;
    if (entry.kind === "member" && entry.value === undefined) return;
    if (entry.kind === "relation") {
      requireAlive(internal);
      return internal.relationView!(property);
    }
    const facade =
      entry.kind === "field"
        ? createFieldFacade(internal, property, entry.runtime)
        : wrapMember(internal, entry.value);
    cacheFacadeHandle(internal, property, facade);
    return facade;
  }
  const definition = internal.runtimeDefinition;
  const field = definition.fields.get(property);
  if (field) {
    const facade = createFieldFacade(internal, property, field);
    cacheFacadeHandle(internal, property, facade);
    return facade;
  }
  if (definition.relations.has(property) || definition.inverses.has(property)) {
    requireAlive(internal);
    return internal.relationView!(property);
  }
  const members = definition.kind === "static" ? definition.staticMembers : internal.ownMembers;
  const member = members?.get(property);
  if (member !== undefined) {
    const cached = wrapMember(internal, member);
    cacheFacadeHandle(internal, property, cached);
    return cached;
  }
}

export type InstanceFacadePlan = Readonly<
  Record<
    string,
    | { kind: "field"; runtime: FieldRuntime; direct: DirectModelMember | null | undefined }
    | { kind: "relation"; direct: null }
    | { kind: "member"; value: unknown; direct: DirectModelMember | null | undefined }
    | undefined
  >
>;
const instanceFacadePlans = new WeakMap<ModelDefinition, InstanceFacadePlan>();
/** Immutable declaration routing is shared by every registry, not by instance state. */
export function instanceFacadePlanOf(definition: ModelDefinition): InstanceFacadePlan | undefined {
  if (definition.kind !== "static") return;
  let plan = instanceFacadePlans.get(definition);
  if (!plan) {
    const entries = { __proto__: facadeCachePrototype } as Record<
      string,
      Exclude<InstanceFacadePlan[string], undefined>
    >;
    // `direct`: the entry's direct member (see `resolveDirectMember`), once asked for.
    for (const [name, runtime] of definition.fields)
      entries[name] = { kind: "field", runtime, direct: undefined };
    const relation = { kind: "relation" as const, direct: null };
    for (const name of definition.relations.keys()) entries[name] = relation;
    for (const name of definition.inverses.keys()) entries[name] = relation;
    for (const [name, value] of definition.staticMembers ?? [])
      entries[name] = { kind: "member", value, direct: undefined };
    instanceFacadePlans.set(definition, (plan = entries));
  }
  return plan;
}

const instanceProxy: ProxyHandler<object> = {
  get(base, property, receiver) {
    if (typeof property !== "string") return instanceSymbol(base, property, receiver);
    const internal = InstanceTarget.state(base);
    // A single cached unit is the common scalar-view/read path. Preserve the
    // prototype probe (including reentrant Proxy traps) exactly once.
    let checked = false;
    if (internal.firstFacadeHandle === property) {
      const cached = internal.facadeHandles;
      checked = property in base;
      if (!checked) return cached;
    }
    if (
      property === "id" &&
      Reflect.getPrototypeOf(base) === instanceTargetPrototype &&
      !Object.hasOwn(base, property)
    ) {
      return internal.id;
    }
    if (checked || property in base || property === "then") {
      const nativeGetter =
        (property === "key" || property === "alive") &&
        Reflect.getPrototypeOf(base) === instanceTargetPrototype &&
        !Object.hasOwn(base, property);
      const value = Reflect.get(base, property, nativeGetter ? base : receiver);
      return typeof value === "function" ? boundInstanceMethod(base, property, value) : value;
    }

    // Cache handles, never values. Explicit own/prototype overrides above still
    // win, while immutable declarations need no repeated metadata traversal.
    const first = internal.firstFacadeHandle;
    const cached =
      first === property
        ? internal.facadeHandles
        : first === undefined
          ? (internal.facadeHandles as Record<string, unknown> | undefined)?.[property]
          : undefined;
    if (cached !== undefined) return cached;
    return uncachedInstanceMember(internal, property);
  },

  has(base, property) {
    if (property === modelInstanceBinding) return true;
    const internal = InstanceTarget.state(base);
    return (
      property in base ||
      (typeof property === "string" &&
        (internal.runtimeDefinition.fields.has(property) ||
          internal.runtimeDefinition.relations.has(property) ||
          internal.runtimeDefinition.inverses.has(property) ||
          memberOf(internal, property) !== undefined))
    );
  },
  getOwnPropertyDescriptor(base, property) {
    if (property === modelInstanceBinding && !Object.hasOwn(base, property))
      Object.defineProperty(base, property, ownInstanceDescriptor(base, instanceBindingDescriptor));
    if (
      !Object.hasOwn(base, property) &&
      Reflect.getPrototypeOf(base) === instanceTargetPrototype &&
      typeof property === "string" &&
      Object.hasOwn(instanceDescriptors, property)
    ) {
      Object.defineProperty(
        base,
        property,
        ownInstanceDescriptor(
          base,
          instanceDescriptors[property as keyof typeof instanceDescriptors],
        ),
      );
    }
    const descriptor = Reflect.getOwnPropertyDescriptor(base, property);
    if (descriptor && "value" in descriptor && typeof property === "string") {
      descriptor.value = boundInstanceMethod(base, property, descriptor.value);
    }
    return descriptor;
  },
  preventExtensions(base) {
    materializeInstanceApi(base);
    for (const key of detachableMethods.keys())
      boundInstanceMethod(base, key, Reflect.get(base, key));
    return Reflect.preventExtensions(base);
  },
  getPrototypeOf(base) {
    const prototype = Reflect.getPrototypeOf(base);
    return prototype === instanceTargetPrototype ? Object.prototype : prototype;
  },
  setPrototypeOf(base, prototype) {
    materializeInstanceApi(base);
    return Reflect.setPrototypeOf(base, prototype);
  },
  ownKeys(base) {
    if (Reflect.getPrototypeOf(base) !== instanceTargetPrototype) return Reflect.ownKeys(base);
    const keys = Object.create(null) as Record<PropertyKey, unknown>;
    for (const key of Object.keys(instanceDescriptors)) keys[key] = true;
    for (const key of Reflect.ownKeys(base)) keys[key] = true;
    keys[modelInstanceBinding] = true;
    return Reflect.ownKeys(keys);
  },
  defineProperty(base, property, descriptor) {
    materializeInstanceApi(base);
    return Reflect.defineProperty(base, property, descriptor);
  },
  deleteProperty(base, property) {
    materializeInstanceApi(base);
    return Reflect.deleteProperty(base, property);
  },
};

export function createInstanceFacade(internal: InstanceInternal): object {
  // Ordinary field/member access shares the API's descriptors and methods.
  // Reflection and mutation lazily restore the same own-property layout.
  if (internal.facade) return internal.facade;
  const target = new InstanceTarget(internal);
  const facade = new Proxy(target, instanceProxy);
  InstanceTarget.attach(target, facade);
  internal.facade = facade;
  internal.facadeTarget = target;
  return facade;
}

interface DefaultViewPlan {
  readonly count: number;
  readonly fields: readonly {
    runtime: FieldRuntime;
    key: string | null | false;
    node?: Node;
    api?: object;
  }[];
  readonly capture: ModelViewCapture;
}
const defaultViewPlans = new WeakMap<ModelDefinition, DefaultViewPlan | null>();
/** `json()` of the instance as it is when read; reads track nothing. */
class LiveViewCapture implements ModelViewCapture {
  readonly #internal: InstanceInternal;
  constructor(internal: InstanceInternal) {
    this.#internal = internal;
  }
  read(): Readonly<Record<string, unknown>> {
    const internal = this.#internal;
    requireAlive(internal);
    return untrackedRead(() => runInInstance(internal, () => serializeInstance(internal)));
  }
}

class DefaultViewCapture implements ModelViewCapture {
  constructor(readonly values: Readonly<Record<string, unknown>>) {}
  read(): Readonly<Record<string, unknown>> {
    return this.values;
  }
}
// A view's capture lives as long as the props it may read: keep their hidden
// classes (see kernel/shapes.ts).
retainShapes(
  "core/models/captures",
  new LiveViewCapture({} as InstanceInternal),
  new DefaultViewCapture({}),
);

/** Only pure primitive declaration defaults can be shared without a per-instance copy. */
function captureDefaultView(internal: InstanceInternal): ModelViewCapture | undefined {
  const definition = internal.runtimeDefinition;
  if (
    !internal.scope ||
    internal.scope.values.size ||
    isTracking() ||
    activeTransactionDepth() ||
    definition.relations.size
  )
    return;
  let plan = defaultViewPlans.get(definition);
  if (plan === undefined) {
    const fields: {
      runtime: FieldRuntime;
      key: string | null | false;
      node?: Node;
      api?: object;
    }[] = [];
    const values: Record<string, unknown> = {};
    for (const [name, runtime] of definition.fields) {
      const binding = runtime.def.binding;
      if (binding.key === false) {
        fields.push({ runtime, key: false });
        continue;
      }
      const unit = runtime.staticStore;
      const state = unit && nativeStoreStateOf(unit);
      const initial = state?.initial;
      const key = binding.key ?? name;
      if (
        !state ||
        key === "__proto__" ||
        (initial !== null && typeof initial === "object") ||
        typeof initial === "function" ||
        binding.in ||
        binding.out ||
        runtime.def.codec ||
        unit!.node.resolveScope
      ) {
        defaultViewPlans.set(definition, null);
        return;
      }
      values[key] = initial;
      fields.push({ runtime, key: binding.key, node: unit!.node, api: nativeStoreApiOf(unit) });
    }
    plan = {
      count: definition.fields.size,
      fields,
      capture: new DefaultViewCapture(Object.freeze(values)),
    };
    defaultViewPlans.set(definition, plan);
  }
  if (!plan || plan.count !== definition.fields.size) return;
  for (const { runtime, key, node, api } of plan.fields) {
    const binding = runtime.def.binding;
    if (
      binding.key !== key ||
      (key !== false &&
        (binding.in || binding.out || runtime.def.codec || node!.resolveScope || !readsValueNatively(api!)))
    )
      return;
  }
  return plan.capture;
}

function serializeInstance(internal: InstanceInternal): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  if (!internal.temporaryId) {
    // Autogenerated ids never serialize (§10.1) — the server assigns its own.
    out.id = internal.id;
  }

  for (const [name, runtime] of internal.runtimeDefinition.fields) {
    const binding = runtime.def.binding;

    if (binding.key === false) continue;

    if (fieldIsOneWay(runtime.def)) {
      if (!binding.inOnly && typeof console !== "undefined") {
        // eslint-disable-next-line no-console
        console.warn(
          `[models] field "${name}" is bound with an in-transform only and was omitted from json(); add an out-transform or mark .inOnly() (§9.1)`,
        );
      }

      continue;
    }

    const key = binding.key === null ? name : binding.key;
    const storeUnit = fieldStoreFor(internal, name);
    let value: unknown;
    const api =
      !isTracking() && internal.runtimeDefinition.kind === "static"
        ? nativeStoreApiOf(storeUnit)
        : undefined;
    if (api && readsValueNatively(api)) {
      const definition = internal.runtimeDefinition;
      const native =
        internal.scope && (definition.sid || definition.name)
          ? nativeStoreStateOf(storeUnit)
          : undefined;
      value =
        native?.snapshot && !(native.snapshot.identity as Node).resolveScope
          ? readModelStoreState(internal.scope!, native, internal.parentScope)
          : readScopeStoreValue(internal.scope ?? internal.parentScope, storeUnit);
      if (
        value !== null &&
        (typeof value === "object" || typeof value === "function") &&
        "then" in value
      )
        value = runInInstance(internal, () => storeUnit.value);
    } else value = runInInstance(internal, () => storeUnit.value);

    out[key] = fieldOut(runtime.def, value);
  }

  if (internal.runtimeDefinition.relations.size) internal.serializeRelations?.(out);

  return out;
}

// ---------------------------------------------------------------------------
// The ambient `self` for static setup: fields resolve to the shared stores (the
// active scope picks the instance), members resolve lazily, instance API
// resolves the ambient instance and errors outside unit bodies (§3.1).

function createStaticSelf(
  fields: ReadonlyMap<string, FieldRuntime>,
  relations: ReadonlyMap<string, RelationRuntime>,
  inverses: ReadonlyMap<string, InverseRuntime>,
  members: Map<string, unknown>,
  singleton?: () => InstanceInternal,
): object {
  const fieldLookup = { __proto__: facadeCachePrototype } as Record<
    string,
    FieldRuntime | undefined
  >;
  for (const [name, runtime] of fields) fieldLookup[name] = runtime;
  const requireAmbient = (operation: string): InstanceInternal => {
    if (singleton) return singleton();
    const scope = getActiveScope();
    const internal = scope ? instanceOfScope(scope) : undefined;

    if (!internal) {
      throw new Error(`[models] self.${operation} needs an instance context — it is only available inside unit bodies (reactions, effects), not in the setup body itself (§3.1)`);
    }

    return internal;
  };

  return new Proxy(Object.create(null), {
    get(_target, property) {
      if (typeof property !== "string") return undefined;

      const runtime = fieldLookup[property];

      if (runtime) {
        const ambient = getActiveScope();
        const instance = ambient && instanceOfScope(ambient);
        if (instance) requireAlive(instance);
        return runtime.staticStore;
      }

      if (relations.has(property) || inverses.has(property)) {
        const internal = requireAmbient(property);

        requireAlive(internal);

        return internal.relationView!(property);
      }

      if (property === "id") return requireAmbient("id").id;
      if (property === "key") return requireAmbient("key").key;

      if (property === "alive") {
        const internal = requireAmbient("alive");

        internal.onAliveRead?.();

        return internal.alive;
      }

      if (property === "json") {
        return () => {
          const internal = requireAmbient("json()");

          requireAlive(internal);

          return serializeInstance(internal);
        };
      }

      if (property === "rebind") {
        return (newId: string) => {
          const internal = requireAmbient("rebind()");

          requireAlive(internal);

          const oldId = internal.id;

          if (oldId === newId) return;

          internal.onBeforeRebind?.(newId);
          internal.id = newId;
          internal.temporaryId = false;
          internal.onRebind?.(oldId, newId);
        };
      }

      if (property === "dispose") {
        return () => {
          const internal = requireAmbient("dispose()");

          return internal.onDispose?.(internal);
        };
      }

      if (property === "onCleanup") {
        // The per-instance cleanup tool for STATIC models (§10.4): a unit body
        // subscribes to something external and ties the unsubscribe to the
        // ambient instance — no store, no per-instance units.
        return (cleanup: () => void) =>
          registerInstanceCleanup(requireAmbient("onCleanup()"), cleanup);
      }

      return members.get(property);
    },
  });
}

// ---------------------------------------------------------------------------
// Definitions

function validateShape(fields: ReadonlyMap<string, unknown>): void {
  for (const name of fields.keys()) {
    if (RESERVED.has(name)) {
      throw new Error(`[models] field "${name}" collides with the instance/definition API (§4.6) — rename it`);
    }
  }
}

function relationDefault(def: RelationDef): unknown {
  return def.cardinality === "many" ? [] : null;
}

function createBroadcastRouter(
  publicDefinition: () => ModelDefinition,
  singleton?: () => InstanceInternal,
): <C extends { run: (...args: never[]) => unknown }>(config: C) => C {
  return (config) => ({
    ...config,
    run: (...args: never[]) => {
      const active = getActiveScope();
      const unwrapped = active ? unwrapMicroScope(active) : null;
      const ambient = unwrapped ? instanceOfScope(unwrapped) : undefined;
      const definition = publicDefinition();

      if (singleton && unwrapped) {
        const instance = singleton();
        return runInInstance(instance, () =>
          withOwner(taskOwnerOf(instance), () => config.run(...args)),
        );
      }

      if (ambient && publicOf(ambient.definition) === definition) {
        // per-instance path: an own unit fired through an instance facade
        return withOwner(taskOwnerOf(ambient), () => config.run(...args));
      }

      if (!broadcastResolver || !unwrapped) return config.run(...args);

      // §3.4 broadcast: normalize past a foreign instance scope, walk the live
      // instances of THIS model in that scope, run in each instance scope.
      let home = unwrapped;
      let foreign = instanceOfScope(home);

      while (foreign) {
        home = unwrapMicroScope(foreign.parentScope);
        foreign = instanceOfScope(home);
      }

      const pending: Promise<unknown>[] = [];
      for (const instance of broadcastResolver(definition, home)) {
        if (!instance.alive || !instance.scope) continue;
        const result = runInInstance(instance, () => config.run(...args), true);
        if (result && typeof (result as PromiseLike<unknown>).then === "function") {
          const release = retainScopeTask(instance.scope);
          pending.push(Promise.resolve(result).finally(release));
        }
      }

      return pending.length ? Promise.all(pending).then(() => undefined) : undefined;
    },
  });
}

function publicOf(definition: ModelDefinition): ModelDefinition {
  return (definition as unknown as { "~public"?: ModelDefinition })["~public"] ?? definition;
}

const modelConfigs = new WeakMap<ModelDefinition, ModelConfig>();

interface SingletonDeclaration {
  readonly source: ModelDefinition;
  readonly values: ReadonlyMap<string, unknown>;
  current(): InstanceInternal;
}

/** @internal Rebuild the description, not the original model's unit graph. */
export function createSingletonDefinition(
  source: ModelDefinition,
  declaration: number,
  input: Record<string, unknown>,
  values: ReadonlyMap<string, unknown>,
  current: () => InstanceInternal,
): ModelDefinition {
  const config = modelConfigs.get(source);
  if (!config) throw new Error("[models] Unknown model definition");
  const address = config.sid ?? config.name;
  return wrapDefinitionWithDescriptors(
    buildDefinition(
      "static",
      {
        ...config,
        name: config.name ? `${config.name}.static:${declaration}` : undefined,
        sid: address ? `${address}/static:${declaration}` : undefined,
        setup: (self) => config.setup?.(self, input as never),
      },
      { source, values, current },
    ),
  );
}

function buildDefinition(
  kind: ModelKind,
  config: ModelConfig,
  singleton?: SingletonDeclaration,
): ModelDefinition {
  const ownData = resolveDataDeclaration(config.data);
  const shape = composeShape(config.with ?? [], ownData.fields, ownData.relations);
  const declared = new Map<string, unknown>([...shape.fields, ...shape.relations]);

  validateShape(declared as ReadonlyMap<string, FieldDef>);

  const fields = new Map<string, FieldRuntime>();
  const relations = new Map<string, RelationRuntime>();
  const inverses = new Map<string, InverseRuntime>();
  const locals = new Set<unknown>();
  let staticMembers: Map<string, unknown> | undefined;

  // Relation defs are cloned per definition: a trait's RelationDef is shared by
  // every model composing it, but Self resolution and the target cache are
  // per-model (§5.4).
  const cloneRelations = (definitionRef: () => ModelDefinition): void => {
    for (const [name, entry] of shape.relations) {
      if (isInverseDef(entry)) {
        inverses.set(name, { name, def: { ...entry, resolved: undefined } });
        continue;
      }

      const def: RelationDef = {
        ...entry,
        resolvedTarget: undefined,
        ...(singleton && entry.target === Self ? { target: singleton.source } : {}),
      };

      Object.defineProperty(def, "owner", {
        configurable: true,
        get: () => {
          const raw = definitionRef() as unknown as { "~public"?: ModelDefinition };

          return raw["~public"] ?? definitionRef();
        },
      });

      if (kind === "static") {
        const staticStore = store<unknown>(relationDefault(def), undefined, {
          name: config.name ? `${config.name}.${name}` : name,
          sid:
            singleton && (config.sid || config.name)
              ? `model:${config.sid ?? config.name}/relation:${name}`
              : undefined,
        });

        relations.set(name, { name, def, staticStore });
        locals.add(storeStateId(staticStore));
      } else {
        relations.set(name, { name, def });
      }
    }
  };

  cloneRelations(() => definition);

  if (kind === "static") {
    for (const [name, def] of shape.fields) {
      const staticStore = store<unknown>(
        singleton ? singleton.values.get(name) : def.defaultValue?.value,
        undefined,
        {
          name: config.name ? `${config.name}.${name}` : name,
          sid:
            config.sid || config.name
              ? `model:${config.sid ?? config.name}/field:${name}`
              : undefined,
        },
      );

      fields.set(name, { name, def, staticStore });
      locals.add(storeStateId(staticStore));
    }

    staticMembers = new Map();

    const self = createStaticSelf(fields, relations, inverses, staticMembers, singleton?.current);
    const previousTransform = setReactionConfigTransform(
      createBroadcastRouter(() => publicOf(definition), singleton?.current),
    );
    const previousSetup = setModelSetupContext(new SetupContext(kind));

    try {
      withStoreDeclarationTracker(
        (declaration) => locals.add(declaration.id),
        () => {
          for (const traitDef of shape.traits) {
            const returned = traitDef.setup?.(self as never);

            mergeMembers(staticMembers!, returned, declared);
          }

          const returned = config.setup?.(self as never);

          mergeMembers(staticMembers!, returned, declared);
        },
      );
    } finally {
      setModelSetupContext(previousSetup);
      setReactionConfigTransform(previousTransform);
    }

    for (const behavior of shape.behaviors) {
      if (!staticMembers.has(behavior)) {
        throw new Error(`[models] model does not implement required behavior "${behavior}" — return it from setup (§4.6)`);
      }
    }
  } else {
    for (const [name, def] of shape.fields) {
      fields.set(name, { name, def });
    }
  }

  const definition: ModelDefinition = {
    [definitionBrand]: true,
    "~model": true,
    ...(singleton ? { "~singletonOf": singleton.source } : {}),
    kind,
    name: config.name,
    idFromProps: config.id,
    sid: config.sid,
    fields,
    relations,
    inverses,
    behaviors: shape.behaviors,
    traits: shape.traits,
    fieldOrigins: shape.origins,
    staticMembers,
    setup: config.setup,
    onCreate: staticMembers ? withMemberInitialization(staticMembers, config.onCreate) : config.onCreate,
    locals: kind === "static" ? locals : undefined,
    create(
      props: Record<string, unknown> | readonly Record<string, unknown>[],
      options?: AddOptions,
    ) {
      const instances = instancesOf(definition);
      return instances.add(props as Record<string, unknown>, options);
    },
    static(input?: Record<string, unknown>) {
      const factory = (
        definition as ModelDefinition & { "~static"?: (input?: Record<string, unknown>) => object }
      )["~static"];
      if (!factory) throw new Error("[models] Import model/staticModel from @virentia/core/models");
      return factory(input);
    },
    get(id: string) {
      return instancesOf(definition).get(id);
    },
    get instances() {
      return instancesOf(definition);
    },
    where(predicate: Predicate<any> | ((instance: object) => boolean)) {
      return instancesOf(definition).where(predicate as Parameters<Collection["where"]>[0]);
    },
    sort(by: SortToken) {
      return instancesOf(definition).sort(by);
    },
    take(count: number) {
      return instancesOf(definition).take(count);
    },
  } as ModelDefinition;

  // Inspecting a definition must not read scope-dependent state.
  Object.defineProperty(definition, "instances", { enumerable: false });
  modelConfigs.set(definition, config);
  return definition;
}

function mergeMembers(
  members: Map<string, unknown>,
  returned: Record<string, unknown> | void,
  fields: ReadonlyMap<string, unknown>,
): void {
  if (!returned) return;

  for (const [name, member] of Object.entries(returned)) {
    if (RESERVED.has(name)) {
      throw new Error(`[models] setup returned "${name}" which collides with the instance/definition API (§4.6) — rename it`);
    }

    if (fields.has(name)) {
      throw new Error(`[models] setup returned "${name}" which is already declared as a field — declarations may not collide (§4.6)`);
    }

    if (members.has(name)) {
      throw new Error(`[models] two setups both provide "${name}" — exactly one participant may declare a member (§4.6)`);
    }

    members.set(name, member);
  }
}

// The kernel keys scope state by an internal store id. We recover it through a
// probe scope: `seedScopeStoreValue` writes directly under that id without
// running the graph, so the probe is free of side effects.
function storeStateId(target: StoreWritable<unknown>): unknown {
  const probe: Scope = { values: new Map(), handlers: new Map(), deps: new Map() };

  seedScopeStoreValue(probe, target, undefined);

  const [id] = probe.values.keys();

  return id;
}

/** Dynamic instance: stores and units per instance, wrapped in an owner for cascade dispose. */
export function instantiateDynamic(
  definition: ModelDefinition,
  scope: Scope,
  values: ReadonlyMap<string, unknown>,
  props: Record<string, unknown>,
  internal: InstanceInternal,
): {
  stores: Map<string, StoreWritable<unknown>>;
  members: Map<string, unknown>;
  ownOwner: Owned<object>;
  ownerRef: Owner;
} {
  const stores = new Map<string, StoreWritable<unknown>>();
  const members = new Map<string, unknown>();
  let ownerRef!: Owner;
  let settingUp = true;

  const requireUnitBody = (operation: string): InstanceInternal => {
    if (settingUp) {
      throw new Error(`[models] self.${operation} needs an instance context — it is only available inside unit bodies, not in the setup body itself (§3.1)`);
    }

    return internal;
  };

  const ownOwner = owner((_dispose, o) => {
    ownerRef = o;

    // The collection's scope is the instance's home (§3.4): setup and the units
    // it creates must not depend on whatever scope is ambient at add() time.
    return runScopeTask(scope, () => {
      for (const [name, runtime] of definition.fields) {
        stores.set(
          name,
          store<unknown>(runtime.def.defaultValue?.value, undefined, {
            sid:
              definition.sid || definition.name
                ? `model:${definition.sid ?? definition.name}/field:${name}`
                : undefined,
          }),
        );
      }

      for (const [name, runtime] of definition.relations) {
        stores.set(name, store<unknown>(relationDefault(runtime.def)));
      }

      // Values are seeded BEFORE setups run — setup reads see the input (§3.1).
      for (const [name, value] of values) {
        seedModelStoreValue(scope, stores.get(name)!, value);
      }

      internal.ownStores = stores;
      internal.ownMembers = members;

      const self = new Proxy(Object.create(null), {
        get(_target, property) {
          if (typeof property !== "string") return undefined;

          if (definition.relations.has(property) || definition.inverses.has(property)) {
            const target = requireUnitBody(property);

            requireAlive(target);

            return target.relationView!(property);
          }

          const own = stores.get(property);

          if (own) return own;

          if (property === "id") return requireUnitBody("id").id;
          if (property === "key") return requireUnitBody("key").key;

          if (property === "alive") {
            const target = requireUnitBody("alive");

            target.onAliveRead?.();

            return target.alive;
          }

          if (property === "json") {
            return () => {
              const target = requireUnitBody("json()");

              requireAlive(target);

              return serializeInstance(target);
            };
          }

          if (property === "rebind") {
            return (newId: string) => {
              const target = requireUnitBody("rebind()");

              requireAlive(target);

              const oldId = target.id;

              if (oldId === newId) return;

              target.onBeforeRebind?.(newId);
              target.id = newId;
              target.temporaryId = false;
              target.onRebind?.(oldId, newId);
            };
          }

          if (property === "dispose") {
            return () => {
              return requireUnitBody("dispose()").onDispose?.(internal);
            };
          }

          if (property === "onCleanup") {
            // Dynamic instances know themselves statically — usable right in
            // the setup body, alongside owner-attached subscriptions (§10.4).
            return (cleanup: () => void) => registerInstanceCleanup(internal, cleanup);
          }

          return members.get(property);
        },
      });

      const declaredNames = new Map<string, unknown>([
        ...definition.fields,
        ...definition.relations,
        ...definition.inverses,
      ]);

      const previousSetup = setModelSetupContext(new SetupContext("dynamic"));
      try {
      for (const traitDef of definition.traits) {
        mergeMembers(members, traitDef.setup?.(self as never) ?? undefined, declaredNames);
      }

      const returned = definition.setup?.(self as never, props as never);

      mergeMembers(members, returned ?? undefined, declaredNames);
      } finally { setModelSetupContext(previousSetup); }

      for (const behavior of definition.behaviors) {
        if (!members.has(behavior)) {
          throw new Error(`[models] model does not implement required behavior "${behavior}" — return it from setup (§4.6)`);
        }
      }

      settingUp = false;

      return {};
    });
  });

  return { stores, members, ownOwner, ownerRef };
}

interface TypedFnModelConfig<
  W extends readonly (TraitDef & AnyTraitTyped)[],
  S extends Record<string, unknown>,
  R extends ShapeRecord,
  M extends MembersRecord | void,
  ExtraSetupArgs extends readonly unknown[],
> {
  with?: W;
  data: (props: Props<S>) => R;
  setup?: (
    self: SelfOf<LocalizeUnbound<R> & TraitsShape<W>, TraitsMembers<W>, TraitsRequiredBehaviors<W>>,
    ...args: ExtraSetupArgs
  ) => M;
  onCreate?: (
    self: Instance<
      LocalizeUnbound<R> & TraitsShape<W>,
      (NoInfer<M> extends void ? {} : NoInfer<M>) & TraitsMembers<W> & TraitsRequiredBehaviors<W>
    >,
  ) => void;
  name?: string;
  id?: (props: S & import("./types").DtoFromShape<LocalizeUnbound<R>>) => string;
  sid?: string;
}

interface TypedModelConfig<
  W extends readonly (TraitDef & AnyTraitTyped)[],
  R extends ShapeRecord,
  M extends MembersRecord | void,
  ExtraSetupArgs extends readonly unknown[],
> {
  with?: W;
  data?: R;
  setup?: (
    self: SelfOf<R & TraitsShape<W>, TraitsMembers<W>, TraitsRequiredBehaviors<W>>,
    ...args: ExtraSetupArgs
  ) => M;
  onCreate?: (
    self: Instance<
      R & TraitsShape<W>,
      (NoInfer<M> extends void ? {} : NoInfer<M>) & TraitsMembers<W> & TraitsRequiredBehaviors<W>
    >,
  ) => void;
  name?: string;
  id?: (props: import("./types").DtoFromShape<R>) => string;
  sid?: string;
}

type TypedModelResult<
  W extends readonly (TraitDef & AnyTraitTyped)[],
  S extends Record<string, unknown>,
  R extends ShapeRecord,
  M extends MembersRecord | void,
> = ModelWithDescriptors<
  R & TraitsShape<W>,
  (M extends void ? {} : M) & TraitsMembers<W> & TraitsRequiredBehaviors<W>,
  S & TraitsProps<W>
>;

/** Экземпляр типизированной модели — экспортный алиас для аннотаций пользователей. */
export type InstanceOfModel<M> = M extends { "~shape"?: infer Sh; "~members"?: infer Mm }
  ? Sh extends ShapeRecord
    ? Mm extends MembersRecord
      ? Instance<Sh, Mm>
      : never
    : never
  : never;

export function model<
  const W extends readonly (TraitDef & AnyTraitTyped)[] = [],
  S extends Record<string, unknown> = {},
  R extends ShapeRecord = {},
  M extends MembersRecord | void = void,
>(
  config: TypedFnModelConfig<W, S, R, M, [props: Record<string, unknown>]>,
): TypedModelResult<W, S, LocalizeUnbound<R>, M>;
export function model<
  const W extends readonly (TraitDef & AnyTraitTyped)[] = [],
  R extends ShapeRecord = {},
  M extends MembersRecord | void = void,
>(
  config: TypedModelConfig<W, R, M, [props: Record<string, unknown>]>,
): TypedModelResult<W, {}, R, M>;
export function model(config: ModelConfig): ModelDefinition;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function model(config: any): any {
  if (!dynamicInstantiation)
    setDynamicModelRuntime(instantiateDynamic, initializeDynamicModelValues);
  return wrapDefinitionWithDescriptors(buildDefinition("dynamic", config));
}

export function staticModel<
  const W extends readonly (TraitDef & AnyTraitTyped)[] = [],
  S extends Record<string, unknown> = {},
  R extends ShapeRecord = {},
  M extends MembersRecord | void = void,
>(config: TypedFnModelConfig<W, S, R, M, []>): TypedModelResult<W, S, LocalizeUnbound<R>, M>;
export function staticModel<
  const W extends readonly (TraitDef & AnyTraitTyped)[] = [],
  R extends ShapeRecord = {},
  M extends MembersRecord | void = void,
>(config: TypedModelConfig<W, R, M, []>): TypedModelResult<W, {}, R, M>;
export function staticModel(config: ModelConfig): ModelDefinition;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function staticModel(config: any): any {
  return wrapDefinitionWithDescriptors(buildDefinition("static", config));
}

// ---------------------------------------------------------------------------
// Field descriptors on the definition (§8): `Todo.done` names the field for
// queries and sorting; the value surface lives on instances only.

export interface FieldDescriptor {
  readonly "~descriptor": true;
  readonly model: ModelDefinition;
  readonly field: string;
  eq(value: unknown): DescriptorPredicate;
  neq(value: unknown): DescriptorPredicate;
  gt(value: unknown): DescriptorPredicate;
  gte(value: unknown): DescriptorPredicate;
  lt(value: unknown): DescriptorPredicate;
  lte(value: unknown): DescriptorPredicate;
  between(from: unknown, to: unknown): DescriptorPredicate;
  startsWith(prefix: string): DescriptorPredicate;
  includes(part: unknown): DescriptorPredicate;
  readonly asc: DescriptorSort;
  readonly desc: DescriptorSort;
}

export interface DescriptorPredicate {
  readonly "~predicate": true;
  readonly model: ModelDefinition;
  readonly field: string;
  readonly op: "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "between" | "startsWith" | "includes";
  readonly value: unknown;
  readonly upper?: unknown;
}

export interface DescriptorSort {
  readonly "~sort": true;
  readonly model: ModelDefinition;
  readonly field: string;
  readonly direction: "asc" | "desc";
}

function createDescriptor(definition: ModelDefinition, field: string): FieldDescriptor {
  const predicate = (
    op: DescriptorPredicate["op"],
    value: unknown,
    upper?: unknown,
  ): DescriptorPredicate => ({ "~predicate": true, model: definition, field, op, value, upper });

  return {
    "~descriptor": true,
    model: definition,
    field,
    eq: (value) => predicate("eq", value),
    neq: (value) => predicate("neq", value),
    gt: (value) => predicate("gt", value),
    gte: (value) => predicate("gte", value),
    lt: (value) => predicate("lt", value),
    lte: (value) => predicate("lte", value),
    between: (from, to) => predicate("between", from, to),
    startsWith: (prefix) => predicate("startsWith", prefix),
    includes: (part) => predicate("includes", part),
    asc: { "~sort": true, model: definition, field, direction: "asc" },
    desc: { "~sort": true, model: definition, field, direction: "desc" },
  };
}

function wrapDefinitionWithDescriptors(definition: ModelDefinition): ModelDefinition {
  const descriptors = new Map<string, FieldDescriptor>();

  const proxied = new Proxy(definition, {
    get(base, property, receiver) {
      if (
        typeof property === "string" &&
        !(property in base) &&
        (base.fields.has(property) || base.relations.has(property) || base.inverses.has(property))
      ) {
        let descriptor = descriptors.get(property);

        if (!descriptor) {
          descriptor = createDescriptor(receiver as ModelDefinition, property);
          descriptors.set(property, descriptor);
        }

        return descriptor;
      }

      return Reflect.get(base, property, receiver);
    },
  });

  (definition as unknown as { "~public"?: ModelDefinition })["~public"] = proxied;
  runtimeDefinitions.set(proxied, definition);
  const config = modelConfigs.get(definition);
  if (config) modelConfigs.set(proxied, config);

  return proxied;
}
