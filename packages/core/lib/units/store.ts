import { runDetached } from "../kernel";
import { retainShapes } from "../kernel/shapes";
import {
  beginWalkKeepingRemovals,
  endWalkKeepingRemovals,
  growthVersion,
  topologyChanged,
  topologyShrank,
  topologyVersion,
} from "../kernel/topology";
import { registerOwnedNode } from "../kernel/create";
import { boundStoreScopeOf, resolveModelStoreScope, setStoreObservationHooks } from "./binding";
import {
  queuedSlot,
  trySynchronousObserver,
  canPropagateSynchronously,
  enterPropagationStep,
  exitPropagationStep,
  isSynchronousSink,
  runSynchronousSink,
  containPropagationFailure,
  isDrainCommitting,
  isDrainActive,
} from "../kernel/run";
import type { KernelWorkItem } from "../kernel/internal";
import { reportContainedError } from "../kernel/report";
import type { KernelExecutionContext, Node } from "../kernel";
import {
  beginUpdateEpoch,
  currentUpdateEpoch,
  isPendingStoreValue,
  readStagedStore,
  readTransactionStore,
  copyPendingStoreValues,
  writeNativeStore,
  commitUnobservedWrite,
  applyNativeWrite,
  writeKnownNativeStore,
  hasStoreTransaction,
  NativeStoreTransactionTarget,
  enterTransaction,
  exitTransaction,
  setNativeBatchPublisher,
  type PendingStoreWrite,
  type StagedNativeWrite,
} from "../kernel/transaction";
import {
  describeNode,
  isInspectorEnabled,
  linkInspectorNodes,
  readInspectorNodeMeta,
  withInspectorMeta,
} from "../kernel/inspector";
import {
  hasScopedObservers,
  soleScopedObserver,
  visitScopedObservers,
  visitScopedSources,
  type ScopedObserverVisitor,
  reconcileScopedOwnedEdges,
  reconcileScopedSource,
  detachScopedDependent,
  sharedScopedEdge,
} from "../kernel/scoped-edges";
import { unwrapMicroScope } from "../scope/micro";
import {
  getActiveRealScope,
  getActiveScope,
  scopeRequiredError,
  setActiveScope,
} from "../scope/internal";
import type { Scope } from "../scope";
import type { NativeModelScope, NativeScope } from "../scope/native";
import {
  copyScopeSnapshotState,
  materializeSnapshotStore,
  hasPendingSnapshot,
  resolveStoreSid,
  trackComputedDeclaration,
  trackNativeStoreDeclaration,
  type SnapshotStore,
} from "../scope/snapshot";
import {
  collectNodes,
  collectNodeSourcesInto,
  collectReadsInto,
  type ReadCapture,
  isTracking,
  isCollectingNodeSources,
  trackNode,
} from "../graph/deps";
import {
  getOwner,
  ownedUnsubscribe,
  registerCleanup,
  withOwner,
  withoutOwner,
  type Owner,
} from "../graph/owner";

const defaultSkipToken = Symbol("virentia.skip");

/** @internal Actual scope of a dependency, including inherited app stores. */
export function storeNotificationScopeOf(node: Node, scope: Scope): Scope {
  const home = unwrapMicroScope(node.resolveScope?.(scope) ?? scope);
  return node instanceof StoreCore && !node.resolveScope
    ? resolveModelStoreScope(home, node.valueKey) : home;
}

export function storeReadScopeOf(unit: { node: Node; subscribe: Function }, scope: Scope): Scope {
  const bound = boundStoreScopeOf(unit);
  if (bound) return bound;
  const node = unit.node, home = storeNotificationScopeOf(node, scope);
  if (node instanceof StoreCore && !node.resolveScope && home !== unwrapMicroScope(scope)) {
    // An app dependency first consumed by a model must also publish in its app
    // when a model body writes it. The resolver captures no application scope.
    node.resolveScope = next => resolveModelStoreScope(unwrapMicroScope(next), node.valueKey);
  }
  return home;
}
let computedSourceCapture: { source?: Node; second?: Node; nodes?: Set<Node> } | undefined;
let computedReadCapture: ReadCapture | undefined;
// Reads a computed must make before matching them beats collecting a Set.
const matchedReadsThreshold = 16;
const nativeStoreApi = Symbol("virentia.nativeStoreApi");
const nativeStoreMode = Symbol("virentia.nativeStoreMode");
type NativeStoreReader = ((scope?: Scope, modelRead?: boolean) => unknown) & {
  api?: object;
  reactive?: boolean;
};
/**
 * The core of a native store or computed, by its public object: a value
 * store holds it as a symbol-keyed field, a reactive store's proxy target as a
 * property.
 * A facade over a store (a model member) is not the store itself.
 */
function coreOf(value: unknown): StoreCore<any> | undefined {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return undefined;
  const core = (value as { [storeCoreKey]?: StoreCore<any> })[storeCoreKey];
  return core !== undefined && core.unit === value ? core : undefined;
}
export interface NativeStoreState {
  /** Lazy model-only guard for live native API/prototype overrides. */
  api?: object;
  /** Shared field-facade source; static instances retain just this descriptor. */
  readonly unit: StoreWritable<unknown>;
  readonly node: Node;
  readonly id: symbol;
  readonly initial: unknown;
  readonly snapshot?: SnapshotStore;
}
const fixedScopedStores = new WeakMap<object, { node: Node; scope: Scope }>();
/** @internal Native facades resolve their own fixed node without a side-table entry. */
export const fixedScopedStoreNode = Symbol("virentia.fixedScopedStoreNode");
const readSnapshotScopes = new WeakSet<Scope>();
let hasReadSnapshotScopes = false;

// A scope-less observer discovers a computed's dependencies by evaluating it in
// an empty scope (see ComputedStore.onObserve). Observers attached in one
// synchronous burst — a graph or a component tree wiring up — share that scope:
// a dependency already evaluated for an earlier observer is then read from its
// cache instead of re-running its whole upstream graph, so observing every node
// of a deep graph is linear rather than quadratic. Nothing writes to the scope,
// so its values, all derived from declaration defaults, cannot go stale; it is
// dropped at the next microtask so it retains nothing past the burst.
let bootstrapScope: Scope | undefined;
function sharedBootstrapScope(): Scope {
  if (bootstrapScope === undefined) {
    bootstrapScope = { values: new Map(), handlers: new Map(), deps: new Map() };
    queueMicrotask(releaseBootstrapScope);
  }
  return bootstrapScope;
}
function releaseBootstrapScope(): void {
  bootstrapScope = undefined;
}
/**
 * @internal The scope a computed discovers its dependencies in when first
 * observed. It reads nothing for anyone: a bridge must not forward writes to it.
 */
export function isBootstrapScope(scope: Scope): boolean {
  return scope === bootstrapScope;
}

// Like a store write, one bridge notification reaches each dependent once per
// drain, even when the dependent also holds a global edge to the bridge.
const scopeReadBatch = Symbol("virentia.scopeReadBridge");
const scopeReadBridges = new WeakMap<
  Node,
  {
    changed: Node;
    known: WeakSet<Scope>;
    readers: Set<{ scope: WeakRef<Scope>; home: WeakRef<Scope> }>;
  }
>();

/** A native application unit read from an instance must invalidate that reader's cache. */
export function trackScopedRead(
  source: Node,
  active: Scope,
  home: Scope,
  staticParent = false,
): void {
  if (!source.resolveScope) {
    if (!staticParent || !isCollectingNodeSources()) trackNode(source);
    return;
  }
  const reader = unwrapMicroScope(active);
  if (reader === home || !isTracking()) {
    trackNode(source);
    return;
  }
  let bridge = scopeReadBridges.get(source);
  if (!bridge) {
    const changed: Node = {};
    const readers = new Set<{ scope: WeakRef<Scope>; home: WeakRef<Scope> }>();
    const forward: Node = {
      run(ctx) {
        for (const entry of readers) {
          const scope = entry.scope.deref(),
            home = entry.home.deref();
          if (!scope || !home) {
            readers.delete(entry);
            continue;
          }
          if (home === ctx.scope)
            runDetached({ unit: changed, payload: ctx.value, scope, batchKey: scopeReadBatch });
        }
      },
    };
    if (source.next) source.next.push(forward);
    else source.next = [forward];
    topologyChanged();
    bridge = { changed, readers, known: new WeakSet() };
    scopeReadBridges.set(source, bridge);
  }
  if (!bridge.known.has(reader) && reader !== bootstrapScope) {
    bridge.known.add(reader);
    bridge.readers.add({ scope: new WeakRef(reader), home: new WeakRef(home) });
  }
  trackNode(bridge.changed);
}

// A `store` is always accessed through `.value`, regardless of whether it holds
// a primitive or an object. For direct field access on object state use `reactive`.
export type StoreView<T> = { readonly value: T };

export type StoreWrite<T> = { value: T };

// A `reactive` exposes the object state directly: fields are read and written on
// the unit itself, without a `.value` indirection.
export type ReactiveView<T> = Readonly<T>;

export type ReactiveWrite<T> = T;

export type StoreSubscriber<T> = (value: T, scope: Scope) => void;
export interface StoreDevtoolsOptions {
  name?: string;
  key?: boolean;
  sid?: string;
  /** @internal Preserve an explicit second argument when a compiler adds metadata. */
  hasSkipToken?: boolean;
}

export type Store<T> = StoreView<T> & StoreApi<T>;
export type StoreWritable<T> = StoreWrite<T> &
  StoreApi<T> & {
    readonly writable: true;
  };

export type Reactive<T> = ReactiveView<T> & StoreApi<T>;
export type ReactiveWritable<T> = ReactiveWrite<T> &
  StoreApi<T> & {
    readonly writable: true;
  };

export interface StoreApi<T> {
  readonly node: Node;
  readonly writable: boolean;
  readonly sid?: string;
  subscribe(fn: StoreSubscriber<T>): () => void;
  map<Next>(fn: (value: T) => Next, skipToken?: Next): Store<Next>;
  filter(fn: (value: T) => boolean): Store<T>;
  filterMap<Next>(fn: (value: T) => Next, skipToken: Next): Store<Next>;
}

type StoreMode = "ref" | "reactive";

interface StoreOptions<T> {
  writable: boolean;
  mode: StoreMode;
  skipToken?: T;
  hasSkipToken: boolean;
  name?: string;
  key?: boolean;
  sid?: string;
}

interface ComputedOptions<T> extends Omit<StoreOptions<T>, "writable" | "mode"> {
  initialValue?: T;
  hasInitialValue?: boolean;
}

interface ComputedState<T> {
  computing: boolean;
  dirty: boolean;
  // A computed this one reads (maybe through others) went stale: before its
  // value is used, those sources are brought up to date, and it recomputes
  // only if one of them changed (which marks it dirty).
  check: boolean;
  initialized: boolean;
  skipped: boolean;
  value?: T;
  // Snapshot of `value` taken when this computed went dirty, BEFORE any read
  // could refresh the cache. Propagation compares against this instead of
  // `value`: a read landing between the invalidation and the propagation
  // recomputes `value`, and comparing the cache against itself would report
  // "unchanged" and silently swallow the notification.
  pendingCompare: boolean;
  pendingHadValue: boolean;
  pendingValue?: T;
  // Update epoch in which the pending comparison was set up.
  pendingEpoch: number;
  // Update epoch in which it was marked for a check: a source whose value
  // changed in this epoch or later makes it recompute.
  checkEpoch: number;
  // Update epoch in which its value last changed.
  changedEpoch: number;
  // Serial of its last value change, and the serial current when it was last
  // brought up to date (see `changeSerial`).
  changedSerial: number;
  settledSerial: number;
  // Epoch in which `value` was first materialized in this scope. A lazy derived
  // read for the first time PARTWAY THROUGH an update already reflects the new
  // world, so it must not be mistaken for a pre-change value.
  materializedEpoch: number;
}

/** Native cache identity needs no weak side-table registration per scope. */
class NativeComputedState<T> implements ComputedState<T> {
  // A new state may meet edges a previous one left (see `scopedEdges`).
  #flags = 128;
  dirty = true;
  initialized = false;
  get computing(): boolean {
    return (this.#flags & 1) !== 0;
  }
  set computing(value: boolean) {
    this.#flags = value ? this.#flags | 1 : this.#flags & ~1;
  }
  get check(): boolean {
    return (this.#flags & 2) !== 0;
  }
  set check(value: boolean) {
    this.#flags = value ? this.#flags | 2 : this.#flags & ~2;
  }
  get skipped(): boolean {
    return (this.#flags & 8) !== 0;
  }
  set skipped(value: boolean) {
    this.#flags = value ? this.#flags | 8 : this.#flags & ~8;
  }
  get pendingCompare(): boolean {
    return (this.#flags & 16) !== 0;
  }
  set pendingCompare(value: boolean) {
    this.#flags = value ? this.#flags | 16 : this.#flags & ~16;
  }
  get pendingHadValue(): boolean {
    return (this.#flags & 32) !== 0;
  }
  set pendingHadValue(value: boolean) {
    this.#flags = value ? this.#flags | 32 : this.#flags & ~32;
  }
  /** Whether reconciling may have left edges of the computed in this scope. */
  get scopedEdges(): boolean {
    return (this.#flags & 128) !== 0;
  }
  set scopedEdges(value: boolean) {
    this.#flags = value ? this.#flags | 128 : this.#flags & ~128;
  }
  /** Whether the computed was observed when `reads` were reconciled. */
  get readsObserved(): boolean {
    return (this.#flags & 64) !== 0;
  }
  set readsObserved(value: boolean) {
    this.#flags = value ? this.#flags | 64 : this.#flags & ~64;
  }
  materializedEpoch = -1;
  pendingEpoch = -1;
  checkEpoch = -1;
  changedEpoch = -1;
  changedSerial = 0;
  settledSerial = 0;
  value: T | undefined = undefined;
  /** The computed's slot in a root scope's state cache; -1 until cached. */
  slot = -1;
  /**
   * What the computed read in this scope when last evaluated, besides its
   * static dependency: one node, or all of them in order (none: `noReads`).
   * A check brings the computeds among them up to date and compares their
   * changes with `settledSerial`. A fan-in computed's re-evaluation reading
   * exactly these again leaves its edges as they are (see collectAndReconcile).
   */
  reads: Node | readonly Node[] | undefined = undefined;
  pendingValue: T | undefined = undefined;
  static is(value: object): boolean {
    return #flags in value;
  }
}

// A scope's computed states die with it: keep their hidden class (see
// kernel/shapes.ts).
retainShapes("core/units/computed-state", new NativeComputedState<unknown>());

export function store<T>(
  initial: T,
  skipToken?: T,
  devtools?: StoreDevtoolsOptions,
): StoreWritable<T> {
  // The common `store(initial)` shares one options object: a store reads its
  // options only while it is constructed.
  if (arguments.length === 1) return createStore(initial, plainStoreOptions) as StoreWritable<T>;
  return createStore(initial, {
    writable: true,
    mode: "ref",
    skipToken,
    hasSkipToken:
      devtools?.hasSkipToken ??
      (arguments.length > 1 && !(arguments.length === 3 && skipToken === undefined)),
    name: devtools?.name,
    key: devtools?.key,
    sid: devtools?.sid,
  }) as StoreWritable<T>;
}

export function readStoreValue<T>(store: Store<T>): T {
  const core = coreOf(store);

  if (!core) {
    throw new Error("Unknown store");
  }

  return core.read() as T;
}

/** @internal A model facade can share the native API target without nesting Proxies. */
export function nativeStoreApiOf(value: unknown): object | undefined {
  return coreOf(value)?.modelReader().api;
}

/** Model facades already tracked their caller before entering the concrete home scope. */
export function nativeModelStoreInfoOf(
  unit: unknown,
): (NativeStoreReader & { api: object }) | undefined {
  return coreOf(unit)?.modelReader();
}

/** @internal Read native constructor/wire state without allocating a scoped callback. */
export function readScopeStoreValue<T>(scope: Scope, store: Store<T>): T {
  const core = coreOf(store);
  if (!core) throw new Error("Unknown store");
  return core.read(scope) as T;
}

/** @internal Reactive bookkeeping follows the same staging/notification path as assignment. */
export function updateScopeStoreValue<T>(
  scope: Scope,
  store: StoreWritable<T>,
  update: (value: T) => T,
): void {
  const core = coreOf(store);
  if (
    !(core instanceof NativeStore) ||
    !(core.flags & STORE_WRITABLE) ||
    core.flags & STORE_REACTIVE
  )
    throw new Error("Unknown writable store");
  const previous = setActiveScope(scope);
  try {
    core.update(scope, update as (value: unknown) => unknown);
  } finally {
    setActiveScope(previous);
  }
}

// The declaration-time initial of a plain (non-computed) store — what a fresh
// scope reads before any write. `reset` restores targets to it; derived-store
// operators use it as the derived initial. Computeds have no stored initial,
// hence the predicate for callers that need to degrade instead of throw.
export function hasInitialValue(store: Store<unknown>): boolean {
  return coreOf(store) instanceof NativeStore;
}

export function initialValueOf<T>(store: Store<T>): T {
  const core = coreOf(store);
  if (!(core instanceof NativeStore)) {
    throw new Error("initialValueOf: not a plain store (computeds have no stored initial)");
  }

  return core.initial as T;
}

function writableStoreOf(store: object): NativeStore<unknown> {
  const core = coreOf(store);
  if (!(core instanceof NativeStore) || !(core.flags & STORE_WRITABLE))
    throw new Error("Scope values can contain only writable stores");
  return core;
}

export function seedScopeStoreValue<T>(scope: Scope, store: StoreWritable<T>, value: T): void {
  writableStoreOf(store as object).seed(scope, value);
}

/** @internal Constructor defaults must not overwrite a restored model field. */
export function seedModelStoreValue<T>(scope: Scope, target: StoreWritable<T>, value: T): void {
  writableStoreOf(target as object).seed(scope, value, true);
}

/** @internal Shared declaration metadata; native models never clone it per instance. */
export function snapshotStoreOf(target: StoreWritable<unknown>): SnapshotStore | undefined {
  const core = coreOf(target);
  return core instanceof NativeStore ? core.snapshot : undefined;
}

/** @internal Native model constructors share their field seed plan. */
export function nativeStoreStateOf(target: StoreWritable<unknown>): NativeStoreState | undefined {
  const core = coreOf(target);
  return core instanceof NativeStore ? core.state() : undefined;
}

/** @internal The caller already resolved this native field's concrete model scope. */
export function readNativeStoreState(scope: Scope, state: NativeStoreState): unknown {
  return readState(scope, state.node as NativeStore<unknown>);
}

/** @internal Model facades already resolved their concrete, non-micro home scope. */
export function readModelStoreState(
  scope: Scope,
  state: NativeStoreState,
  modelRoot?: Scope,
): unknown {
  const pending = readStagedStore(state.node as NativeStore<unknown>, scope);
  if (isPendingStoreValue(pending)) return pending;
  // The native constructor registered every field SID and restored pending
  // fields before onCreate. Pure reads need not materialize declaration defaults
  // into the value map; serialization already knows their initial values.
  if (modelRoot && state.snapshot && !hasPendingSnapshot(modelRoot)) {
    const value = scope.values.get(state.id);
    return value !== undefined || scope.values.has(state.id) ? value : state.initial;
  }
  return readCommittedState(scope, state.id, state.initial, state.snapshot);
}

/** @internal A renderer may observe a native store's stable node directly. */
export function fixedStoreNodeOf(target: object, scope: Scope): Node | undefined {
  const resolve = (target as { [fixedScopedStoreNode]?: (scope: Scope) => Node | undefined })[
    fixedScopedStoreNode
  ];
  if (typeof resolve === "function") return resolve.call(target, scope);
  const scoped = fixedScopedStores.get(target);
  if (scoped) return scoped.scope === scope ? scoped.node : undefined;
  if (!coreOf(target)) return;
  const source = (target as Store<unknown>).node;
  const home = source.resolveScope?.(scope) ?? scope;
  return unwrapMicroScope(home) === scope ? source : undefined;
}

/** @internal Cross-instance readers still use the model's scoped read bridge. */
export function registerFixedScopedStore(target: object, source: Node, scope: Scope): void {
  fixedScopedStores.set(target, { node: source, scope });
}

/**
 * Capture an in-memory read view for a renderer's initial hydration pass.
 * Store values retain their identity, while maps, lazy SID restoration and
 * computed caches are independent. Use the original scope for events/writes.
 */
export function captureScopeSnapshot(scope: Scope): Scope {
  scope = unwrapMicroScope(scope);
  const snapshot: Scope = {
    values: new Map(),
    handlers: new Map(scope.handlers),
    deps: new Map(scope.deps),
  };
  for (const [id, value] of scope.values) {
    if (isObject(value) && NativeComputedState.is(value)) continue;
    const pending = readTransactionStore(scope, id);
    snapshot.values.set(id, isPendingStoreValue(pending) ? pending : value);
  }
  copyPendingStoreValues(scope, snapshot.values);
  copyScopeSnapshotState(scope, snapshot);
  readSnapshotScopes.add(snapshot);
  hasReadSnapshotScopes = true;
  return snapshot;
}

export function readonlyStore<T>(
  initial: T,
  skipToken?: T,
  devtools?: StoreDevtoolsOptions,
): Store<T> {
  return createStore(initial, {
    writable: false,
    mode: "ref",
    skipToken,
    hasSkipToken:
      devtools?.hasSkipToken ??
      (arguments.length > 1 && !(arguments.length === 3 && skipToken === undefined)),
    name: devtools?.name,
    key: devtools?.key,
    sid: devtools?.sid,
  });
}

export function reactive<T extends object>(
  initial: T,
  skipToken?: T,
  devtools?: StoreDevtoolsOptions,
): ReactiveWritable<T> {
  return createStore(initial, {
    writable: true,
    mode: "reactive",
    skipToken,
    hasSkipToken:
      devtools?.hasSkipToken ??
      (arguments.length > 1 && !(arguments.length === 3 && skipToken === undefined)),
    name: devtools?.name,
    key: devtools?.key,
    sid: devtools?.sid,
  }) as unknown as ReactiveWritable<T>;
}

export function readonlyReactive<T extends object>(
  initial: T,
  skipToken?: T,
  devtools?: StoreDevtoolsOptions,
): Reactive<T> {
  return createStore(initial, {
    writable: false,
    mode: "reactive",
    skipToken,
    hasSkipToken:
      devtools?.hasSkipToken ??
      (arguments.length > 1 && !(arguments.length === 3 && skipToken === undefined)),
    name: devtools?.name,
    key: devtools?.key,
    sid: devtools?.sid,
  }) as unknown as Reactive<T>;
}

export function computed<T>(fn: () => T, skipToken?: T, devtools?: StoreDevtoolsOptions): Store<T> {
  // The common `computed(fn)` shares one options object: a computed never
  // writes to its options.
  if (arguments.length === 1) return createComputed(fn, plainComputedOptions as ComputedOptions<T>);
  return createComputed(fn, {
    skipToken,
    hasSkipToken: arguments.length > 1 && !(arguments.length === 3 && skipToken === undefined),
    name: devtools?.name,
    key: devtools?.key,
  });
}
const plainComputedOptions: ComputedOptions<unknown> = Object.freeze({
  skipToken: undefined,
  hasSkipToken: false,
  name: undefined,
  key: undefined,
});
const plainStoreOptions: StoreOptions<unknown> = Object.freeze({
  writable: true,
  mode: "ref",
  skipToken: undefined,
  hasSkipToken: false,
  name: undefined,
  key: undefined,
  sid: undefined,
});

/** A derivation's options: the shared plain ones unless it has a skip token or a name. */
function derivedOptions<T>(
  skipToken: unknown,
  hasSkipToken: boolean,
  name: string | undefined,
): ComputedOptions<T> {
  return hasSkipToken || name !== undefined
    ? { skipToken: skipToken as T, hasSkipToken, name }
    : (plainComputedOptions as ComputedOptions<T>);
}

const STORE_WRITABLE = 1;
const STORE_REACTIVE = 2;
const STORE_SKIP_TOKEN = 4;
// `sid` is an API member of ref stores and of stores declared with a SID.
const STORE_SID_MEMBER = 8;
// A computed a scope-less observer activated (see ComputedStore.onObserve).
const STORE_OBSERVED = 16;

const storeCoreKey = Symbol("virentia.storeCore");

/** The proxy target: own string keys are exactly the always-present API members. */
interface StoreTarget {
  readonly node: Node;
  readonly writable: boolean;
  // A customized `node` (live declaration patching) must not detach the store
  // from its own state, so the handler finds the core under a private key.
  readonly [storeCoreKey]: StoreCore<any>;
}

// A constructor keeps all three fields in-object, while its instances still look
// like the plain objects the API targets always were (Object.prototype).
function StoreTarget(
  this: { node: Node; writable: boolean; [storeCoreKey]: StoreCore<any> },
  node: StoreCore<any>,
  writable: boolean,
): void {
  this.node = node;
  this.writable = writable;
  this[storeCoreKey] = node;
}
StoreTarget.prototype = Object.prototype;

/**
 * The public object of a value store (`store`, `computed`, a derivation): its
 * `value` and API members live on the prototype, so a read is a getter call
 * rather than a proxy trap. Like the proxy it replaces, it enumerates nothing
 * but its state: no enumerable own properties, `toJSON` for serialization. It
 * stays an ordinary extensible object, so a test can spy on its members.
 */
class ValueStoreUnit {
  // A field read through `this`, not a private one: a proxy wrapped around the
  // store (a model facade, a Vue `reactive`) forwards reads with itself as the
  // receiver, and still reaches it. It is a symbol: keys and JSON skip it.
  readonly [storeCoreKey]: StoreCore<unknown>;
  constructor(core: StoreCore<unknown>) {
    this[storeCoreKey] = core;
  }
  // Getters reached through something other than a store (an inspector
  // printing the prototype, a test spy taking a member's getter detached)
  // read nothing.
  get value(): unknown {
    return this?.[storeCoreKey]?.readForProxy();
  }
  set value(next: unknown) {
    const core = this?.[storeCoreKey];
    if (!core || !(core.flags & STORE_WRITABLE)) throw new Error("Store is read-only");
    core.writeProperty("value", next);
  }
  get node(): Node | undefined {
    return this?.[storeCoreKey];
  }
  get writable(): boolean {
    return ((this?.[storeCoreKey]?.flags ?? 0) & STORE_WRITABLE) !== 0;
  }
  // A member is the store's own bound function, stable for a detached call.
  // Read from elsewhere, it is a method that finds the store through `this`,
  // which is what a spy installed on the store ends up calling.
  get subscribe(): unknown {
    return this?.[storeCoreKey]?.member("subscribe") ?? unboundMembers.subscribe;
  }
  get map(): unknown {
    return this?.[storeCoreKey]?.member("map") ?? unboundMembers.map;
  }
  get filter(): unknown {
    return this?.[storeCoreKey]?.member("filter") ?? unboundMembers.filter;
  }
  get filterMap(): unknown {
    return this?.[storeCoreKey]?.member("filterMap") ?? unboundMembers.filterMap;
  }
  get sid(): unknown {
    const sid = this?.[storeCoreKey]?.member("sid");
    return sid === noMember ? undefined : sid;
  }
  get [nativeStoreApi](): object {
    return this;
  }
  get [nativeStoreMode](): string {
    return "ref";
  }
  toJSON(): { value: unknown } {
    return { value: this.value };
  }
}
function unboundMember(name: string) {
  return function (this: ValueStoreUnit, ...args: unknown[]): unknown {
    return (this[storeCoreKey].member(name) as (...a: unknown[]) => unknown)(...args);
  };
}
const unboundMembers = {
  subscribe: unboundMember("subscribe"),
  map: unboundMember("map"),
  filter: unboundMember("filter"),
  filterMap: unboundMember("filterMap"),
};

/**
 * @internal Whether a store holds one value (`"ref"`: `store`, `computed`, a
 * derivation) or an object state (`"reactive"`); undefined for anything else.
 * A value store has no own `value` key to tell it by.
 */
export function storeModeOf(unit: unknown): "ref" | "reactive" | undefined {
  if (unit === null || (typeof unit !== "object" && typeof unit !== "function")) return undefined;
  const mode = (unit as { [nativeStoreMode]?: unknown })[nativeStoreMode];
  return mode === "ref" || mode === "reactive" ? mode : undefined;
}

/** @internal A store's prototype as a plain object shows it: a value store's own class stays hidden. */
export function apiPrototypeOf(api: object): object | null {
  const prototype = Reflect.getPrototypeOf(api);
  return prototype === ValueStoreUnit.prototype ? Object.prototype : prototype;
}

/** @internal Whether a native store API object reads `value` natively (no override). */
export function readsValueNatively(api: object): boolean {
  return Object.getPrototypeOf(api) === ValueStoreUnit.prototype
    ? !Object.hasOwn(api, "value")
    : !("value" in api);
}

/** The "Scope is required" failure of a store access, kept out of its hot callers. */
function missingScope(action: string, node: Node): never {
  throw scopeRequiredError(`${action} ${describeNode(node)}`);
}

// Slots of computeds in root scopes' state caches (see ComputedStateCache).
let nextComputedSlot = 0;

/** Per-store data most stores never need, allocated on first use. */
class StoreExtras {
  name: string | undefined = undefined;
  devtoolsKey: boolean | undefined = undefined;
  sid: string | undefined = undefined;
  meta: Record<string, unknown> | undefined = undefined;
  reader: NativeStoreReader | undefined = undefined;
  state: NativeStoreState | undefined = undefined;
  staticDependencies: Set<Node> | undefined = undefined;
  sharedSources: WeakMap<Node, ReturnType<typeof sharedScopedEdge>> | undefined = undefined;
  initialEdge: ((source: Node) => ReturnType<typeof sharedScopedEdge>) | undefined = undefined;
}

/** Wraps a committed value so a store node can tell it from a fresh write. */
class CommittedStoreUpdate<T> {
  constructor(readonly value: T) {}
}

/**
 * One object per store: it is the store's graph node and holds everything the
 * former per-store closures captured. All stores share one proxy handler.
 */
abstract class StoreCore<T> implements Node {
  resolveScope: ((scope: Scope) => Scope) | undefined = undefined;
  id: PropertyKey | undefined = undefined;
  next: Node[] | undefined = undefined;
  /** What an in-place propagation reached from this node, in one root scope. */
  targetCache: TargetCache | undefined = undefined;
  [queuedSlot]: unknown = undefined;
  /** Key of this store's value in a scope's value map. */
  readonly valueKey: symbol;
  flags: number;
  readonly skipToken: T | undefined;
  subscribers: Set<StoreSubscriber<T>> | undefined = undefined;
  // Private: generic deep-equality walks of a node must not reach the proxy,
  // whose enumeration reads scoped state.
  #unit: object = undefined!;
  #target: StoreTarget = undefined!;
  #extras: StoreExtras | undefined = undefined;
  // Renderers subscribe through a detached `store.subscribe`; keep its identity
  // stable without allocating the extras for it.
  #subscribe: ((fn: StoreSubscriber<T>) => () => void) | undefined = undefined;

  constructor(
    valueKey: symbol,
    flags: number,
    name: string | undefined,
    devtoolsKey: boolean | undefined,
    skipToken: T | undefined,
  ) {
    this.valueKey = valueKey;
    this.flags = flags;
    this.skipToken = skipToken;
    if (name !== undefined || devtoolsKey !== undefined) {
      const extras = this.extras();
      extras.name = name;
      extras.devtoolsKey = devtoolsKey;
    }
  }

  extras(): StoreExtras {
    return (this.#extras ??= new StoreExtras());
  }

  peekExtras(): StoreExtras | undefined {
    return this.#extras;
  }

  get name(): string | undefined {
    return this.#extras?.name;
  }

  get devtoolsKey(): boolean | undefined {
    return this.#extras?.devtoolsKey;
  }

  /** Inspector metadata is materialized only when something reads it. */
  get meta(): Record<string, unknown> {
    const extras = this.extras();
    return (extras.meta ??= this.createMeta());
  }
  set meta(value: Record<string, unknown>) {
    this.extras().meta = value;
  }

  /** The name a derived unit inherits, without materializing metadata. */
  inspectorName(): string | undefined {
    const extras = this.#extras;
    return extras?.meta ? readInspectorNodeMeta(this).name : extras?.name;
  }

  /** The public proxy. */
  get unit(): object {
    return this.#unit;
  }
  /** The proxy target; its own string keys are the always-present API members. */
  get target(): StoreTarget {
    return this.#target;
  }

  /** Publishes the public object (and a reactive store's proxy target); called once, right after construction. */
  attach(): object {
    if (!(this.flags & STORE_REACTIVE)) {
      // A value store's public object is its own API target.
      const unit = new ValueStoreUnit(this as StoreCore<unknown>);
      this.#target = unit as unknown as StoreTarget;
      this.#unit = unit;
      return unit;
    }
    const target = new (StoreTarget as unknown as new (
      node: StoreCore<T>,
      writable: boolean,
    ) => StoreTarget)(this, (this.flags & STORE_WRITABLE) !== 0);
    this.#target = target;
    const unit = new Proxy(target, storeProxyHandler);
    this.#unit = unit;
    return unit;
  }

  isMember(property: PropertyKey): boolean {
    switch (property) {
      case "subscribe":
      case "map":
      case "filter":
      case "filterMap":
        return true;
      case "sid":
        return (this.flags & STORE_SID_MEMBER) !== 0;
    }
    return false;
  }

  /** API member value, or `noMember` for state/unknown keys. */
  member(property: PropertyKey): unknown {
    switch (property) {
      case "subscribe":
        return (this.#subscribe ??= this.#subscribeMember());
      // Derivations are declared once per store: a fresh bound closure per
      // access costs less than keeping one on every store that is mapped.
      case "map":
        return this.#mapMember();
      case "filter":
        return this.#filterMember();
      case "filterMap":
        return this.#filterMapMember();
      case "sid":
        if (this.flags & STORE_SID_MEMBER) return (this as unknown as NativeStore<T>).sid;
    }
    return noMember;
  }

  // Each member closure comes from its own method: a closure in `member` would
  // make every lookup through the proxy, `.value` reads included, allocate.
  #subscribeMember(): (fn: StoreSubscriber<T>) => () => void {
    return (fn) => this.subscribe(fn);
  }
  #mapMember(): (...args: unknown[]) => Store<unknown> {
    return (...args) => this.map(args[0] as (value: T) => unknown, args[1], args.length > 1);
  }
  #filterMember(): (fn: (value: T) => boolean) => Store<T> {
    return (fn) => this.filter(fn);
  }
  #filterMapMember(): (...args: unknown[]) => Store<unknown> {
    return (...args) => this.filterMap(args[0] as (value: T) => unknown, args[1]);
  }

  hasStateKey(property: PropertyKey): boolean {
    if (!(this.flags & STORE_REACTIVE)) return property === "value";
    const state = this.readForProxy();
    return isObject(state) && property in state;
  }

  /** Callable reader protocol shared with model facades. */
  modelReader(): NativeStoreReader & { api: object } {
    const extras = this.extras();
    let reader = extras.reader;
    if (!reader) {
      reader = ((scope?: Scope, modelRead?: boolean) =>
        this.read(scope, modelRead)) as NativeStoreReader;
      reader.api = this.target;
      if (this.flags & STORE_REACTIVE) reader.reactive = true;
      extras.reader = reader;
    }
    return reader as NativeStoreReader & { api: object };
  }

  protected abstract createMeta(): Record<string, unknown>;
  // An own data property holding a shared function: the kernel (and code that
  // patches a node's runner) sees a plain `run` field, yet no store allocates one.
  declare run: (ctx: KernelExecutionContext) => unknown;
  /** Untracked plain-store read / tracked computed read (the former side-table reader). */
  abstract read(scope?: Scope, modelRead?: boolean): T;
  /** `.value` through the proxy. */
  abstract readForProxy(): T;
  abstract subscribe(fn: StoreSubscriber<T>): () => void;
  abstract map(
    fn: (value: T) => unknown,
    skipToken: unknown,
    hasSkipToken: boolean,
  ): Store<unknown>;
  abstract filter(fn: (value: T) => boolean): Store<T>;
  abstract filterMap(fn: (value: T) => unknown, skipToken: unknown): Store<unknown>;
  writeProperty(_property: PropertyKey, _value: unknown): boolean {
    return false;
  }
  deleteKeyProperty(_property: PropertyKey): boolean {
    return false;
  }
}

class NativeStore<T> extends StoreCore<T> {
  readonly initial: T;
  readonly snapshot: SnapshotStore | undefined;
  run = runNativeStore as (ctx: KernelExecutionContext) => unknown;
  /** This store's latest write staged in a transaction (see StagedNativeWrite). */
  staged: StagedNativeWrite<unknown> | undefined = undefined;
  /** `changeSerial` of its latest committed change, in any scope. */
  committedSerial = 0;
  /**
   * The root scope (its `id`) and graph growth (`growthVersion`) at which
   * everything this store reaches was last found pure: until either changes,
   * a commit there propagates in place without walking its graph first. A
   * removed edge leaves every reachable node as it was, so it keeps the verdict.
   */
  pureIn = 0;
  pureAt = -1;

  constructor(initial: T, options: StoreOptions<T>, sid: string | undefined) {
    super(
      Symbol("virentia.store"),
      (options.writable ? STORE_WRITABLE : 0) |
        (options.mode === "reactive" ? STORE_REACTIVE : 0) |
        (options.hasSkipToken ? STORE_SKIP_TOKEN : 0) |
        (sid !== undefined || options.mode === "ref" ? STORE_SID_MEMBER : 0),
      options.name,
      options.key,
      options.skipToken,
    );
    this.initial = initial;
    if (sid !== undefined) this.extras().sid = sid;
    this.snapshot =
      options.writable && sid !== undefined
        ? { sid, id: this.valueKey, identity: this, initial }
        : undefined;
  }

  get sid(): string | undefined {
    return this.peekExtras()?.sid;
  }

  protected createMeta(): Record<string, unknown> {
    return withInspectorMeta(undefined, {
      type: "store",
      name: this.name,
      key: this.devtoolsKey,
      callable: true,
      writable: (this.flags & STORE_WRITABLE) !== 0,
      sid: this.sid,
    });
  }

  /** Model view of this store's declaration; its identity is stable. */
  state(): NativeStoreState {
    return (this.extras().state ??= {
      unit: this.unit as StoreWritable<unknown>,
      node: this,
      id: this.valueKey,
      initial: this.initial,
      snapshot: this.snapshot,
    });
  }

  runUpdate(ctx: KernelExecutionContext): unknown {
    if (!ctx.scope) {
      throw new Error("Store update requires scope");
    }

    const scope = ctx.scope;
    const value = ctx.value;

    if (value instanceof CommittedStoreUpdate) {
      return value.value;
    }

    const next = value as T;

    if (this.flags & STORE_SKIP_TOKEN && Object.is(next, this.skipToken)) {
      ctx.stop();
      return readState(ctx.scope, this);
    }

    const previous = readCommittedState(scope, this.valueKey, this.initial, this.snapshot);

    if (Object.is(previous, next)) {
      ctx.stop();
      return previous;
    }

    this.#commitImmediateState(scope, next);

    return next;
  }

  #accessScope(write: boolean): Scope {
    const scope = getActiveScope() ?? missingScope(write ? "update" : "read", this);
    return this.resolveScope?.(scope) ?? scope;
  }

  /** `unwrapMicroScope(accessScope(write))`: a store without a context of its own needs no lookup. */
  #realAccessScope(write: boolean): Scope {
    if (this.resolveScope === undefined)
      return getActiveRealScope() ?? missingScope(write ? "update" : "read", this);
    return unwrapMicroScope(this.#accessScope(write));
  }

  read(scope?: Scope): T {
    return readState(scope ? (this.resolveScope?.(scope) ?? scope) : this.#accessScope(false), this);
  }

  readForProxy(): T {
    // Without a context of its own: the real scope of the current execution,
    // tracked as trackScopedRead tracks such a unit.
    if (this.resolveScope === undefined) {
      const scope = getActiveRealScope() ?? missingScope("read", this);
      trackNode(this);
      return readRealState(scope, this);
    }
    const active = getActiveScope() ?? missingScope("read", this);
    const scope = this.resolveScope(active) ?? active;
    trackScopedRead(this, active, scope);

    return readState(scope, this);
  }

  /** Reactive bookkeeping: same staging/notification path as assignment. */
  update(scope: Scope, update: (value: unknown) => unknown): void {
    const home = this.resolveScope?.(scope) ?? scope;
    trackScopedRead(this, scope, home);
    const real = unwrapMicroScope(home);
    const previous = readState(real, this);
    this.#writeResolvedState(real, update(previous) as T, previous);
  }

  seed(scope: Scope, value: unknown, preserveRestored?: boolean): void {
    scope = unwrapMicroScope(scope);
    const restored = this.snapshot ? materializeSnapshotStore(scope, this.snapshot) : false;
    if (preserveRestored && Object.is(value, this.initial) && !scope.values.has(this.valueKey))
      return;
    if (!preserveRestored || !restored) scope.values.set(this.valueKey, value);
  }

  subscribe(fn: StoreSubscriber<T>): () => void {
    const active = getActiveScope();
    const scope = active && unwrapMicroScope(this.resolveScope?.(active) ?? active);
    if (scope && this.snapshot)
      readCommittedState(scope, this.valueKey, this.initial, this.snapshot);
    const subscribers = (this.subscribers ??= new Set());
    subscribers.add(fn);
    return ownedUnsubscribe(subscriberRemover(subscribers, fn));
  }

  map(fn: (value: T) => unknown, skipToken: unknown, hasSkipToken: boolean): Store<unknown> {
    return createComputed(
      () => fn(this.#readSource()),
      derivedOptions(skipToken, hasSkipToken, deriveName(this, "map")),
      this,
    );
  }

  filter(fn: (value: T) => boolean): Store<T> {
    return createComputed(
      () => {
        const value = this.#readSource();

        return fn(value) ? value : (defaultSkipToken as T);
      },
      {
        skipToken: defaultSkipToken as T,
        hasSkipToken: true,
        initialValue: this.initial,
        hasInitialValue: true,
        name: deriveName(this, "filter"),
      },
      this,
    );
  }

  filterMap(fn: (value: T) => unknown, skipToken: unknown): Store<unknown> {
    return createComputed(
      () => fn(this.#readSource()),
      { skipToken, hasSkipToken: true, name: deriveName(this, "filterMap") },
      this,
    );
  }

  /** A derived unit's read of its static source. */
  #readSource(): T {
    return readRealState(this.#realAccessScope(false), this);
  }

  writeProperty(property: PropertyKey, value: unknown): boolean {
    return this.flags & STORE_REACTIVE
      ? this.#writeReactiveProperty(property, value)
      : this.#writeNativeProperty(value);
  }

  #writeReactiveProperty(property: PropertyKey, value: unknown): boolean {
    // A write belongs to the real scope, never the per-run micro-scope overlay a
    // reaction body installs: this scope keys the transaction staging AND is the
    // identity handed to subscribers, who may compare it against the scope they
    // provided (useUnit does) — a micro-scope there would make them drop the
    // notification even though the value committed into their scope.
    const scope = this.#realAccessScope(true);
    const state = readRealState(scope, this);

    return this.#writeResolvedState(scope, assignProperty(state, property, value), state);
  }

  #writeNativeProperty(value: unknown): boolean {
    const scope = this.#realAccessScope(true);
    if (!hasStoreTransaction()) {
      const snapshot = this.snapshot;
      if (snapshot) materializeSnapshotStore(scope, snapshot);
      const previous = scope.values.get(this.valueKey);
      const had = previous !== undefined || scope.values.has(this.valueKey);
      if (!snapshot || had) {
        if (
          (this.flags & STORE_SKIP_TOKEN && Object.is(value, this.skipToken)) ||
          Object.is(value, had ? previous : this.initial)
        )
          return true;
        writeKnownNativeStore(this, this.valueKey, scope, value as T, previous, had);
        return true;
      }
    }
    return this.#writeResolvedState(scope, value as T, readRealState(scope, this));
  }

  #writeResolvedState(scope: Scope, next: T, state: T): boolean {
    if (this.flags & STORE_SKIP_TOKEN && Object.is(next, this.skipToken)) {
      return true;
    }

    if (Object.is(state, next)) {
      return true;
    }

    // In a transaction, a store nobody observes in this scope commits now. A
    // tracked run (an auto reaction, a computed) may still observe it when it
    // ends, and must then be notified at commit.
    if (hasStoreTransaction() && !isInspectorEnabled()) {
      if (
        !this.subscribers?.size &&
        !isTracking() &&
        !hasGraphObservers(scope, this) &&
        commitUnobservedWrite(this, this.valueKey, scope, next, state, this.initial)
      )
        return true;
      // An observed store commits now too; it publishes when the transaction does.
      if (applyNativeWrite(this, this.valueKey, scope, next, state, this.initial)) return true;
    }

    writeNativeStore(this, this.valueKey, scope, next);

    return true;
  }

  deleteKeyProperty(property: PropertyKey): boolean {
    // Same as writeProperty: writes are keyed and notified by the real scope.
    const scope = this.#realAccessScope(true);
    const state = readRealState(scope, this);

    // Deleting an absent key (or from a non-object state) is a no-op success.
    if (!isObject(state) || !(property in (state as object))) {
      return true;
    }

    const next = removeProperty(state, property);

    writeNativeStore(this, this.valueKey, scope, next);

    return true;
  }

  changedFrom(committed: unknown, had: boolean, next: T): boolean {
    if (this.flags & STORE_SKIP_TOKEN && Object.is(next, this.skipToken)) return false;
    return !Object.is(had ? committed : this.initial, next);
  }

  commitState(scope: Scope, next: T, committed: unknown, had: boolean): boolean {
    if (this.flags & STORE_SKIP_TOKEN && Object.is(next, this.skipToken)) {
      return false;
    }

    const previous = had ? committed : this.initial;
    if (Object.is(previous, next)) {
      return false;
    }

    this.commitValue(scope, next);

    return true;
  }

  commitValue(scope: Scope, next: T): void {
    scope.values.set(this.valueKey, next);
    this.committedSerial = ++changeSerial;
  }

  publishState(scope: Scope, next: T): void {
    if (this.subscribers?.size) notifyCommitSubscribers(this.subscribers, next, scope, this);
    if (!propagateCommit(scope, this, next)) this.launchGraph(scope, next);
  }

  launchGraph(scope: Scope, next: T): void {
    // State is committed and subscribers have run. With no graph observers
    // there is nothing left to launch: the committed-update node only
    // unwraps the payload. Keep inspected writes visible to devtools.
    if (!isInspectorEnabled() && !this.next?.length) {
      const observer = soleScopedObserver(scope, this);
      if (observer === undefined || (observer !== null && trySynchronousObserver(scope, observer)))
        return;
    }
    runDetached({
      unit: this,
      payload: new CommittedStoreUpdate(next),
      scope,
      batchKey: this.valueKey,
    });
  }

  #commitImmediateState(scope: Scope, next: T): void {
    scope.values.set(this.valueKey, next);
    this.committedSerial = ++changeSerial;
    // This path bypasses the transaction layer, so it opens the update epoch
    // itself rather than inheriting one from a staged write.
    beginUpdateEpoch();
    if (this.subscribers?.size) notifySubscribers(this.subscribers, next, scope, this);
  }
}

function createStore<T>(initial: T, options: StoreOptions<T>): Store<T> {
  const core = registerOwnedNode(new NativeStore(initial, options, resolveStoreSid(options.sid)));
  const proxy = core.attach();
  trackNativeStoreDeclaration(core.valueKey, core.sid, core);
  return proxy as Store<T>;
}

// Notify every subscriber, isolating each: a subscriber that throws must not
// starve the remaining subscribers, nor the store's reactive propagation that
// runs after this loop. Errors are contained here rather than surfaced out of
// the write path (which would break the graph mid-commit).
/** A subscription's removal; the only state its closure holds. */
function subscriberRemover<T>(
  subscribers: Set<StoreSubscriber<T>>,
  fn: StoreSubscriber<T>,
): () => void {
  return () => {
    subscribers.delete(fn);
  };
}

interface ScopedComputedSubscription {
  readonly listener: StoreSubscriber<unknown>;
}
interface ScopedComputedObservers {
  readonly scopes: WeakMap<Scope, Set<ScopedComputedSubscription>>;
  readonly endpoint: Node;
}
const scopedComputedObservers = new WeakMap<ComputedStore<any>, ScopedComputedObservers>();

/** @internal Model facades observe an instance, without globalizing its self-dependent graph. */
export function subscribeComputedInScope(
  unit: object,
  home: Scope,
  listener: StoreSubscriber<unknown>,
): (() => void) | undefined {
  const source = coreOf(unit);
  if (!(source instanceof ComputedStore) || source.resolveScope || (unit as Store<unknown>).node !== source ||
      (unit as Store<unknown>).subscribe !== source.member("subscribe")) return;
  let observers = scopedComputedObservers.get(source);
  if (!observers) {
    const scopes = new WeakMap<Scope, Set<ScopedComputedSubscription>>();
    const endpoint = registerOwnedNode({ run(ctx) {
      if (!ctx.scope) return ctx.value;
      const scope = unwrapMicroScope(ctx.scope), listeners = scopes.get(scope);
      for (const subscription of listeners ?? []) {
        try { subscription.listener(ctx.value, scope); }
        catch (error) { reportContainedError(error, { kind: "store subscriber", subject: describeNode(source) }); }
      }
      return ctx.value;
    } });
    scopedComputedObservers.set(source, observers = { scopes, endpoint });
  }
  let listeners = observers.scopes.get(home);
  if (!listeners) {
    observers.scopes.set(home, listeners = new Set());
    reconcileScopedSource(home, observers.endpoint, source);
  }
  const subscription = { listener };
  listeners.add(subscription);
  initializeScopedComputed(unit, home);
  return () => {
    if (!listeners!.delete(subscription)) return;
    if (!listeners!.size) {
      observers!.scopes.delete(home);
      detachScopedDependent(home, observers!.endpoint);
    }
  };
}

/** A scoped observer must discover partial dependencies even if its first read fails. */
function initializeScopedComputed(unit: object, home: Scope): boolean {
  const source = (unit as Store<unknown>).node;
  if (!(source instanceof ComputedStore) || source.resolveScope || (unit as Store<unknown>).node !== source) return false;
  const previous = setActiveScope(home);
  try {
    // Discover this instance's dependencies, using an existing cache when read.
    // A subscription never publishes the initial value.
    const initial = source.readComputed(home, true);
    if (initial && typeof (initial as PromiseLike<unknown>).then === "function")
      void Promise.resolve(initial).catch(() => {});
  } catch {
    // Keep partial dependencies of an initially failing computed, just as the
    // global observer does; its next source update must be able to recover it.
    discoverFailedScopedComputed(source, home, new Set());
  } finally { setActiveScope(previous); }
  return true;
}

/** Identity check that does not materialize a lazy native subscribe closure. */
function isNativeStoreUnit(unit: object): boolean {
  const source = (unit as Store<unknown>).node;
  return source instanceof StoreCore && source.unit === unit;
}

function discoverFailedScopedComputed(source: ComputedStore<any>, home: Scope, seen: Set<Node>): void {
  if (seen.has(source)) return;
  seen.add(source);
  const captured = collectNodes(() => {
    try {
      const value = source.fn();
      if (value && typeof value.then === "function") void Promise.resolve(value).catch(() => {});
    } catch {}
  });
  for (const dependency of captured.nodes) {
    if (dependency instanceof ComputedStore && !dependency.resolveScope && !seen.has(dependency)) {
      try { dependency.readComputed(home, true); }
      catch { discoverFailedScopedComputed(dependency, home, seen); }
    }
  }
  const state = source.stateIn(home);
  source.reconcileDynamicDependencies(home, undefined, captured.nodes,
    state instanceof NativeComputedState ? state : undefined);
}

function notifySubscribers<T>(
  subscribers: Iterable<StoreSubscriber<T>>,
  next: T,
  scope: Scope,
  owner: Node,
): void {
  for (const subscriber of subscribers) {
    try {
      subscriber(next, scope);
    } catch (error) {
      // Contained — see the note above — but never silent: a subscriber that
      // throws is a bug worth seeing, not a phantom "nothing happened".
      reportContainedError(error, { kind: "store subscriber", subject: describeNode(owner) });
    }
  }
}

// Glitch-free propagation. A store change marks its direct readers dirty and
// every computed further down "check". A checked computed brings the computeds
// it read up to date before its value is used, and recomputes only if one of
// them changed since it was marked, so no reader sees one source new and
// another old.

/** The computeds that read `computed` in `scope` (at any depth) are marked for a check. */
function markReadersForCheck(computed: ComputedStore<any>, scope: Scope): void {
  if (!computed.computedReaders || markingInPlace) return;
  // The walk runs no user code, so it never nests and ends with the stacks
  // empty (one that threw leaves at most extra checks behind).
  checkReadersOf(computed, scope);
  while (checkPending.length > 0) checkReadersOf(checkPending.pop()!, checkHomes.pop()!);
}
function checkReadersOf(computed: ComputedStore<any>, home: Scope): void {
  const next = computed.next;
  if (next) for (let index = 0; index < next.length; index++) checkReader(next[index], home);
  checkVisitor.home = home;
  visitScopedObservers(home, computed, checkVisitor);
}
const checkPending: ComputedStore<any>[] = [];
const checkHomes: Scope[] = [];
// Set while an in-place propagation walks the graph: it marks every reader
// itself, breadth first, so an invalidation must not walk them again.
let markingInPlace = false;
function checkReader(reader: Node, home: Scope): void {
  if (!(reader instanceof ComputedInvalidator)) return;
  const readerHome = markForCheck(reader, home);
  if (readerHome === undefined || !reader.computed.computedReaders) return;
  checkPending.push(reader.computed);
  checkHomes.push(readerHome);
}
/** Marks a clean reader for a check; its home scope, or undefined if it was not clean. */
function markForCheck(reader: ComputedInvalidator<unknown>, home: Scope): Scope | undefined {
  const readerHome = reader.resolveScope ? reader.resolveScope(home) : home;
  const state = reader.computed.stateIn(readerHome);
  if (state.dirty || state.check || state.computing || !state.initialized) return;
  // The pre-change value, kept as an invalidation would: its update compares against it.
  if (!state.pendingCompare && reader.computed.hasObservers(readerHome)) {
    const materializedNow = state.materializedEpoch === currentUpdateEpoch();
    state.pendingCompare = true;
    state.pendingHadValue = !materializedNow;
    state.pendingValue = materializedNow ? undefined : state.value;
    state.pendingEpoch = currentUpdateEpoch();
  }
  state.check = true;
  state.checkEpoch = currentUpdateEpoch();
  return readerHome;
}
const checkVisitor = {
  home: undefined as unknown as Scope,
  visitScopedObserver(observer: Node): boolean {
    checkReader(observer, this.home);
    return true;
  },
};

/** `source` is read by a computed: its changes must reach that reader's check state. */
function noteComputedReader(source: Node): void {
  if (source instanceof ComputedStore && !source.computedReaders) source.computedReaders = true;
}

let refreshScope: Scope = undefined!;
let refreshSince = 0;
let refreshChanged = false;
/** Brings a computed source up to date, until one has changed: the recompute reads the rest. */
function refreshSource(source: Node): void {
  if (refreshChanged || !(source instanceof ComputedStore)) return;
  if (source.refreshIn(refreshScope) >= refreshSince) refreshChanged = true;
}

/**
 * Whether `source`, if a computed, has changed after `serial` in `scope`, once
 * brought up to date there; undefined for one that lives in another scope.
 */
function changedAfter(source: Node, scope: Scope, serial: number): boolean | undefined {
  if (!(source instanceof ComputedStore)) return false;
  if (source.resolveScope) return undefined;
  const state = source.stateIn(scope);
  source.evaluate(scope, state);
  return state.changedSerial > serial;
}

// The reads of a computed that read nothing but its static dependency.
const noReads: readonly Node[] = [];

/** A state's `reads` after an evaluation collected these sources: the last ones if the same. */
function readsOf(
  last: Node | readonly Node[] | undefined,
  source: Node | undefined,
  second: Node | undefined,
  nodes: Set<Node> | undefined,
): Node | readonly Node[] {
  if (nodes !== undefined) {
    if (Array.isArray(last) && last.length === nodes.size) {
      let index = 0;
      for (const node of nodes) if (last[index++] !== node) return Array.from(nodes);
      return last;
    }
    return Array.from(nodes);
  }
  if (second !== undefined)
    return Array.isArray(last) && last.length === 2 && last[0] === source && last[1] === second
      ? last
      : [source!, second];
  return source ?? noReads;
}

/**
 * Brought up to date after its pending comparison was set up in this update:
 * every store this update writes committed before any reader ran, and a
 * computed it read could change since only after an invalidation, which would
 * have marked it for a check. Invalidating it again would only recompute the
 * same value. Its update still compares and notifies.
 */
function isUpToDate(state: ComputedState<unknown>): boolean {
  return (
    !state.dirty && !state.check && state.initialized && state.pendingEpoch === currentUpdateEpoch()
  );
}

// Numbers every change of a computed's value. A computed records the serial
// current when it was last brought up to date, so a change of a computed it
// reads that it has already pulled is told apart from one it has not seen.
let changeSerial = 0;

/**
 * A change of `source` (a computed, or a store's commit) reached a reader that
 * is up to date and was brought there after that change: it read the new value
 * already, and recomputing it would give the same one. A reader first
 * materialized in this update is not covered: its observers have yet to
 * receive any value. A store keeps one serial for all scopes, its latest
 * commit anywhere, so it errs on recomputing.
 */
function sawChangeOf(state: ComputedState<unknown>, source: Node | undefined, scope: Scope): boolean {
  // Cheapest refusals first: a fresh store commit is newer than any reader.
  if (source instanceof NativeStore) {
    if (state.settledSerial < source.committedSerial) return false;
  } else if (source instanceof ComputedStore && !source.resolveScope) {
    if (state.dirty || state.check || state.settledSerial < source.stateIn(scope).changedSerial)
      return false;
  } else return false;
  if (state.dirty || state.check || !state.initialized) return false;
  return state.pendingCompare || state.materializedEpoch !== currentUpdateEpoch();
}

/** Marks a computed dirty on the clean -> dirty edge, then forwards to it. */
class ComputedInvalidator<T> implements Node {
  resolveScope: ((scope: Scope) => Scope) | undefined = undefined;
  id: PropertyKey | undefined = undefined;
  next: Node[];
  [queuedSlot]: unknown = undefined;
  run = runInvalidator as (ctx: KernelExecutionContext) => unknown;
  /** Generation of the last synchronous propagation that reached this node. */
  visited = 0;
  #meta: Record<string, unknown> | undefined = undefined;
  constructor(readonly computed: ComputedStore<T>) {
    this.next = [computed];
  }
  get meta(): Record<string, unknown> {
    return (this.#meta ??= withInspectorMeta(undefined, {
      type: "computed.invalidate",
      name: this.computed.name ? `${this.computed.name}.invalidate` : undefined,
      internal: true,
    }));
  }
  set meta(value: Record<string, unknown>) {
    this.#meta = value;
  }
  invalidate(ctx: KernelExecutionContext): unknown {
    if (!ctx.scope) {
      throw new Error("Computed invalidation requires scope");
    }

    const computed = this.computed;
    const state = computed.stateIn(ctx.scope);

    // Keep the pre-change value until this pending update compares and notifies.
    if (sawChangeOf(state, (ctx as unknown as KernelWorkItem).parent?.node, ctx.scope)) {
      if (!state.pendingCompare) ctx.stop();
      return ctx.value;
    }
    const observed = state.pendingCompare;
    if (!observed) {
      const materializedNow = state.initialized && state.materializedEpoch === currentUpdateEpoch();

      state.pendingCompare = true;
      state.pendingHadValue = state.initialized && !materializedNow;
      state.pendingValue = materializedNow ? undefined : state.value;
      state.pendingEpoch = currentUpdateEpoch();
    } else if (isUpToDate(state)) return ctx.value;

    const clean = !state.dirty && !state.check && state.initialized;
    state.dirty = true;
    if (clean) markReadersForCheck(computed, ctx.scope);

    if (!observed && !computed.hasObservers(ctx.scope)) {
      state.pendingCompare = false;
      state.pendingValue = undefined;
      ctx.stop();
    }

    return ctx.value;
  }
}

class ComputedStore<T> extends StoreCore<T> {
  /** Index of this computed's state in root scopes' state caches. */
  readonly computedSlot = nextComputedSlot++;
  readonly fn: () => T;
  readonly options: ComputedOptions<T>;
  // Activation can happen much later in an arbitrary reader's owner. The
  // computed's shared propagation edges belong to its declaration, not to the
  // first component/test that happens to subscribe to it.
  readonly #declarationOwner: Owner | null;
  readonly invalidator: ComputedInvalidator<T>;
  // Structural deps known at creation (e.g. a `.map` source) are always deps in
  // every scope, so they stay global. Deps discovered while evaluating are
  // data-dependent and tracked per-scope, so a computed that reads different
  // stores in different scopes is invalidated precisely rather than from a
  // global union of every scope's branches. A `.map` has exactly one; more
  // live in the extras.
  staticDependency: Node | undefined = undefined;
  run = runComputed as (ctx: KernelExecutionContext) => unknown;
  /** Generation of the synchronous propagation that queued this update. */
  queuedUpdate = 0;
  /** Some computed has read this one (never reset): its changes mark readers. */
  computedReaders = false;

  constructor(fn: () => T, options: ComputedOptions<T>) {
    super(
      Symbol("virentia.computed"),
      options.hasSkipToken ? STORE_SKIP_TOKEN : 0,
      options.name,
      options.key,
      options.skipToken,
    );
    this.fn = fn;
    this.options = options;
    this.#declarationOwner = getOwner();
    this.invalidator = new ComputedInvalidator(this);
  }

  protected createMeta(): Record<string, unknown> {
    return withInspectorMeta(undefined, {
      type: "computed",
      name: this.name,
      key: this.devtoolsKey,
    });
  }

  runUpdate(ctx: KernelExecutionContext): unknown {
    if (!ctx.scope) {
      throw new Error("Computed update requires scope");
    }

    // Reactions run between an invalidation and this update: when the last one stopped
    // reading it, leave it stale for the next read rather than compute a value
    // nobody takes.
    const state = this.stateIn(ctx.scope);
    if (!this.hasObservers(ctx.scope)) {
      state.pendingCompare = false;
      state.pendingValue = undefined;
      ctx.stop();
      return ctx.value;
    }
    const hadValue = state.pendingCompare ? state.pendingHadValue : state.initialized;
    const previous = state.pendingCompare ? state.pendingValue : state.value;

    state.pendingCompare = false;
    state.pendingValue = undefined;

    const next = this.evaluate(ctx.scope, state);

    if (state.skipped || (hadValue && Object.is(previous, next))) {
      ctx.stop();
      return previous;
    }

    if (this.subscribers?.size) notifySubscribers(this.subscribers, next, ctx.scope, this);

    return next;
  }

  hasStaticDependency(dependency: Node): boolean {
    return (
      dependency === this.staticDependency ||
      (this.peekExtras()?.staticDependencies?.has(dependency) ?? false)
    );
  }

  hasObservers(scope: Scope | null): boolean {
    if (this.subscribers?.size || Boolean(this.next?.length)) {
      return true;
    }

    // Reactions and other computeds may observe this computed per-scope (via
    // scoped edges) rather than through the static `node.next`, so an invalidation
    // must not stop just because there are no static observers.
    return scope ? hasScopedObservers(scope, this) : false;
  }

  read(modelScope?: Scope, modelRead = false): T {
    return this.readComputed(modelScope, modelRead, false);
  }

  readForProxy(): T {
    return this.readComputed(undefined, false, false);
  }

  /** This computed's state in `scope`: through a root scope's cache, else its value map. */
  stateIn(scope: Scope): ComputedState<T> {
    const cache = (scope as NativeModelScope).computedStates;
    if (cache === undefined) return readComputedState<T>(scope, this.valueKey);
    const slot = this.computedSlot;
    const cached = cache.entries[slot & cache.mask];
    if (cached !== undefined && cached.slot === slot) return cached as NativeComputedState<T>;
    const state = readComputedState<T>(scope, this.valueKey);
    if (state instanceof NativeComputedState) cache.store(slot, state);
    return state;
  }

  readComputed(modelScope?: Scope, modelRead = false, staticParent = false): T {
    const resolve = this.resolveScope;
    // Without a context of its own, a computed is read in the real scope of the
    // current execution, resolved once per ambient scope, and its read is
    // tracked as trackScopedRead tracks such a unit.
    if (resolve === undefined && !modelRead) {
      const scope = getActiveRealScope() ?? missingScope("read", this);
      if (!staticParent || !isCollectingNodeSources()) trackNode(this);
      return this.evaluate(scope, this.stateIn(scope));
    }
    // Track (above) sees the micro-scope so the reading reaction depends on this
    // computed. The computed's own state/edges belong to the real scope — a
    // micro-scope is a throwaway per-run overlay, so edges there would be lost.
    const active =
      modelRead && modelScope ? modelScope : (getActiveScope() ?? missingScope("read", this));
    const scope = resolve
      ? unwrapMicroScope(resolve.call(this, active) ?? active)
      : modelRead
        ? active
        : unwrapMicroScope(active);
    if (!modelRead) trackScopedRead(this, active, scope, staticParent);

    return resolve ? this.#evaluateInFrame(scope) : this.evaluate(scope, this.stateIn(scope));
  }

  /** `evaluate` with its home scope active; a closure in readComputed would allocate per read. */
  #evaluateInFrame(scope: Scope): T {
    const previous = setActiveScope(scope);
    try {
      return this.evaluate(scope, this.stateIn(scope));
    } finally {
      setActiveScope(previous);
    }
  }

  evaluate(scope: Scope, state: ComputedState<T>): T {
    if (state.initialized && !state.dirty) {
      if (!state.check) return state.value as T;
      // Bring the computeds it read up to date first. Unless one of them
      // changed since, its value stands without recomputing. It stays checked
      // meanwhile, so it does not pass for up to date.
      const changed =
        this.#readsChangedSince(scope, state) ?? this.#sourcesChangedSince(scope, state.checkEpoch);
      if (!changed && !state.dirty) {
        state.check = false;
        state.settledSerial = changeSerial;
        return state.value as T;
      }
    }

    if (state.computing) {
      throw new Error("Computed cycle detected");
    }

    state.computing = true;
    const hadValue = state.initialized;
    const previous = state.value;

    try {
      const result = this.#collectAndReconcile(scope, state);

      const options = this.options;
      if (options.hasSkipToken && Object.is(result, options.skipToken)) {
        if (!state.initialized) {
          // Never surface the INTERNAL `defaultSkipToken` sentinel (used by
          // `filter`) as a value — fall back to `undefined`. A user-provided
          // skipToken is theirs to observe, so keep it.
          state.value = options.hasInitialValue
            ? options.initialValue
            : Object.is(result, defaultSkipToken)
              ? (undefined as T)
              : result;
          state.initialized = true;
          state.materializedEpoch = currentUpdateEpoch();
        }

        state.skipped = true;
        state.dirty = false;
        state.check = false;
        return state.value as T;
      }

      if (!state.initialized) {
        state.materializedEpoch = currentUpdateEpoch();
      }

      state.value = result;
      state.initialized = true;
      state.skipped = false;
      state.dirty = false;
      state.check = false;
      // A checked reader recomputes when it sees this.
      if (hadValue && !Object.is(previous, result)) {
        state.changedEpoch = currentUpdateEpoch();
        state.changedSerial = ++changeSerial;
      }
      state.settledSerial = changeSerial;

      return result;
    } finally {
      state.computing = false;
    }
  }

  /**
   * Brings the computeds this one read in `scope` up to date; whether one of
   * them changed in `epoch` or later.
   */
  #sourcesChangedSince(scope: Scope, epoch: number): boolean {
    const previousScope = refreshScope,
      previousSince = refreshSince,
      previousChanged = refreshChanged;
    refreshScope = scope;
    refreshSince = epoch;
    refreshChanged = false;
    try {
      const source = this.staticDependency;
      if (source) refreshSource(source);
      const more = this.peekExtras()?.staticDependencies;
      if (more) for (const dependency of more) refreshSource(dependency);
      if (!refreshChanged) visitScopedSources(scope, this.invalidator, refreshSource);
      return refreshChanged;
    } finally {
      refreshScope = previousScope;
      refreshSince = previousSince;
      refreshChanged = previousChanged;
    }
  }

  /**
   * `evaluate` of this computed as a source read from `scope` would run it;
   * the epoch its value last changed in.
   */
  refreshIn(scope: Scope): number {
    const resolve = this.resolveScope;
    if (!resolve) {
      const state = this.stateIn(scope);
      this.evaluate(scope, state);
      return state.changedEpoch;
    }
    const home = unwrapMicroScope(resolve.call(this, scope) ?? scope);
    this.#evaluateInFrame(home);
    return this.stateIn(home).changedEpoch;
  }

  /** Runs `fn`, collecting what it reads, and reconciles the edges in `scope`. */
  #collectAndReconcile(scope: Scope, state: ComputedState<T>): T {
    const observed = (this.flags & STORE_OBSERVED) !== 0;
    const native = state instanceof NativeComputedState ? state : undefined;
    const expected = native?.reads;
    if (
      Array.isArray(expected) &&
      expected.length >= matchedReadsThreshold &&
      native!.readsObserved === observed &&
      scope !== bootstrapScope
    ) {
      // A fan-in computed usually reads the same sources again: match them in
      // order instead of collecting a Set and reconciling every edge.
      const capture = (computedReadCapture ??= {
        same: false,
        source: undefined,
        second: undefined,
        nodes: undefined,
        reads: undefined,
      });
      const result = collectReadsInto(this.fn, capture, expected as readonly Node[]);
      const same = capture.same,
        source = capture.source,
        second = capture.second,
        nodes = capture.nodes,
        reads = capture.reads;
      capture.source = capture.second = capture.nodes = capture.reads = undefined;
      if (same) return result;
      this.reconcileDynamicDependencies(scope, source, nodes, native, second);
      native!.reads = reads;
      native!.readsObserved = (this.flags & STORE_OBSERVED) !== 0;
      return result;
    }
    const sourceCapture = (computedSourceCapture ??= {
      source: undefined,
      second: undefined,
      nodes: undefined,
    });
    const result = collectNodeSourcesInto(this.fn, sourceCapture);
    const source = sourceCapture.source,
      second = sourceCapture.second,
      nodes = sourceCapture.nodes;
    // A dependency callback can re-enter another computed. Consume the shared
    // synchronous output first; it must not retain a source between reads.
    sourceCapture.source = sourceCapture.second = sourceCapture.nodes = undefined;
    // The bootstrap scope outlives the graphs observed in one synchronous burst:
    // what its states read would keep every one of them alive.
    if (native === undefined || scope === bootstrapScope) {
      this.reconcileDynamicDependencies(scope, source, nodes, native, second);
      if (native !== undefined) native.reads = undefined;
      return result;
    }
    const reads = readsOf(native.reads, source, second, nodes),
      nowObserved = (this.flags & STORE_OBSERVED) !== 0;
    // The same reads as when its edges were last reconciled here, observed as
    // it was then: the edges stand (only reconciling changes them).
    if (reads === native.reads && native.readsObserved === nowObserved) return result;
    // A hydration snapshot makes no scoped edges (see
    // reconcileDynamicDependencies), but nothing writes to it either.
    this.reconcileDynamicDependencies(scope, source, nodes, native, second);
    native.reads = reads;
    native.readsObserved = (this.flags & STORE_OBSERVED) !== 0;
    return result;
  }

  /**
   * Whether a computed it read when last brought up to date in `scope` has
   * changed since, each brought up to date first; undefined when what it read
   * there is not known (see `reads`), or was read in another scope.
   */
  #readsChangedSince(scope: Scope, state: ComputedState<T>): boolean | undefined {
    if (!(state instanceof NativeComputedState)) return undefined;
    const reads = state.reads;
    if (reads === undefined) return undefined;
    const settled = state.settledSerial;
    let changed: boolean | undefined;
    const parent = this.staticDependency;
    if (parent !== undefined && (changed = changedAfter(parent, scope, settled)) !== false)
      return changed;
    if (!Array.isArray(reads)) return reads === this ? false : changedAfter(reads as Node, scope, settled);
    for (let index = 0; index < reads.length; index++) {
      const source = reads[index] as Node;
      if (source !== this && (changed = changedAfter(source, scope, settled)) !== false)
        return changed;
    }
    return false;
  }

  reconcileDynamicDependencies(
    scope: Scope,
    source: Node | undefined,
    nodes: Set<Node> | undefined,
    // The computed's state in `scope`: it knows whether edges may need detaching.
    state?: NativeComputedState<T>,
    // A second source, read with `source` and no other (`nodes` is then unset).
    second?: Node,
  ): void {
    // Initial hydration reads must not attach observers to their temporary
    // state or change the globally observed dependency graph.
    if (hasReadSnapshotScopes && readSnapshotScopes.has(scope)) return;
    // Nothing writes to the bootstrap scope: per-scope edges there would only
    // keep nodes alive until it is dropped.
    if (scope === bootstrapScope && !(this.flags & STORE_OBSERVED)) return;
    if (second !== undefined) {
      // As for a set of the two below; an observed computed needs no set.
      if (this.flags & STORE_OBSERVED) {
        noteComputedReader(source!);
        noteComputedReader(second);
        this.attachObserved(source!);
        this.attachObserved(second);
        this.detachScoped(scope, state);
        return;
      }
      nodes = new Set<Node>();
      nodes.add(source!);
      nodes.add(second);
    }
    if (!nodes) {
      if (source === this || (source && this.hasStaticDependency(source))) source = undefined;
      if (source) noteComputedReader(source);
      if (this.flags & STORE_OBSERVED) {
        if (source) {
          this.attachStaticDependency(source);
          source.onObserve?.();
        }
        // Global edges now cover this scope; an edge left from a read before the
        // computed was observed would only invalidate it a second time.
        this.detachScoped(scope, state);
      } else if (source) {
        reconcileScopedSource(
          scope,
          this.invalidator,
          source,
          (this.extras().initialEdge ??= (dependency) => this.#initialScopedEdge(dependency)),
        );
        if (state) state.scopedEdges = true;
      } else this.detachScoped(scope, state);
      return;
    }
    for (const dependency of nodes) noteComputedReader(dependency);
    if (this.flags & STORE_OBSERVED) {
      // A globally-observed computed subscribes in every scope: promote each
      // dependency discovered by this REAL evaluation (real scope values, the
      // real branch taken) to a global edge, and activate any computed dependency
      // transitively. Accumulating deps from real evaluations across scopes covers
      // conditional branches that a bootstrap eval could not reach.
      for (const dependency of nodes) this.attachObserved(dependency);
      this.detachScoped(scope, state);
      return;
    }

    if (state) state.scopedEdges = true;
    if (!this.staticDependency && !nodes.has(this)) {
      reconcileScopedOwnedEdges(scope, this.invalidator, nodes);
    } else {
      const dynamic = new Set<Node>();
      for (const dependency of nodes)
        if (dependency !== this && !this.hasStaticDependency(dependency)) dynamic.add(dependency);
      reconcileScopedOwnedEdges(scope, this.invalidator, dynamic);
    }
  }

  /** An observed computed's read of `dependency`, made a global edge if it is not one. */
  attachObserved(dependency: Node): void {
    if (dependency === this || this.hasStaticDependency(dependency)) return;
    this.attachStaticDependency(dependency);
    dependency.onObserve?.();
  }

  /** Drops the computed's edges in `scope`, unless its state knows it has none there. */
  detachScoped(scope: Scope, state: NativeComputedState<T> | undefined): void {
    if (state !== undefined) {
      if (!state.scopedEdges) return;
      state.scopedEdges = false;
    }
    if (!(this.flags & STORE_OBSERVED)) {
      detachScopedDependent(scope, this.invalidator);
      return;
    }
    // Its global edges reach it from every source it reads now. A walk
    // remembered over the dropped edges stays valid: like a global edge, a
    // left one may invalidate it for a source it no longer reads.
    beginWalkKeepingRemovals();
    try {
      detachScopedDependent(scope, this.invalidator);
    } finally {
      endWalkKeepingRemovals();
    }
  }

  #initialScopedEdge(source: Node): ReturnType<typeof sharedScopedEdge> {
    const cache = (this.extras().sharedSources ??= new WeakMap());
    let edge = cache.get(source);
    if (!edge) cache.set(source, (edge = sharedScopedEdge(source, this.invalidator)));
    return edge;
  }

  prepareInspectorSnapshot(): void {
    // Propagation edges are per-scope, so nothing global to attach. For the
    // inspector graph we still evaluate against a throwaway scope and register
    // inspector-only links (dependency → computed) that don't affect propagation.
    const previousScope = setActiveScope({
      values: new Map(),
      handlers: new Map(),
      deps: new Map(),
    });

    try {
      const collected = collectNodes(this.fn);

      for (const dependency of collected.nodes) {
        if (dependency !== this) {
          linkInspectorNodes(dependency, this, { kind: "reactive" });
        }
      }
    } catch {
      // Inspector snapshots should not make user code fail because a lazy computed cannot be inspected.
    } finally {
      setActiveScope(previousScope);
    }
  }

  attachStaticDependency(dependency: Node): void {
    if (dependency === this || this.hasStaticDependency(dependency)) {
      return;
    }

    const invalidator = this.invalidator;
    if (this.#declarationOwner)
      withOwner(this.#declarationOwner, () => append(dependency, invalidator));
    else withoutOwner(() => append(dependency, invalidator));
    noteComputedReader(dependency);
    if (!this.staticDependency) this.staticDependency = dependency;
    else (this.extras().staticDependencies ??= new Set()).add(dependency);
  }

  // Called when a scope-less (global) observer attaches to this computed. A
  // global subscription must fire in EVERY scope its dependency changes in, not
  // only in scopes where the computed happened to be read. Dependencies are
  // normally discovered lazily, per-scope, on evaluation — so an unread computed
  // has no edges in a fresh scope and never invalidates there. Here we evaluate
  // once in a throwaway scope to discover the dependencies and promote them to
  // GLOBAL edges (like a `.map` source), then transitively activate any computed
  // dependency so a chain of computeds also becomes global.
  //
  // The per-scope precision of an UN-observed computed is untouched: this only
  // runs when a global observer opts in.
  onObserve(): void {
    if (this.flags & STORE_OBSERVED) {
      return;
    }
    // Set once a scope-less observer activates this computed. While observed,
    // dynamic deps discovered by real evaluations are promoted to global edges
    // so the observer fires in every scope, not only where it was read.
    this.flags |= STORE_OBSERVED;

    // A `.map`/`.filter` chain already propagates globally through its static
    // source edges and has no dynamic deps of its own. Do NOT re-run its fn here
    // (that would break its laziness / compute-count contract) — only make sure
    // the chain ABOVE it is activated too, so a raw computed at the root of the
    // chain also becomes global.
    if (this.staticDependency) {
      this.staticDependency.onObserve?.();
      const more = this.peekExtras()?.staticDependencies;
      if (more)
        for (const dependency of more) {
          dependency.onObserve?.();
        }
      return;
    }

    // Bootstrap a raw computed: discover its deps once so the FIRST write in a
    // scope it was never read in already reaches it (real evaluations then refine
    // the global set — see reconcileDynamicDependencies). The body is wrapped so a
    // read that throws (an unprovided `dependency()`, a cycle) still leaves the
    // deps collected BEFORE the throw promoted; the computed re-evaluates correctly
    // in the real scope on the next propagation, where the value IS available.
    const previousScope = setActiveScope(sharedBootstrapScope());

    try {
      const fn = this.fn;
      const collected = collectNodes(() => {
        try {
          fn();
        } catch {
          // Partial discovery: keep whatever was read before the throw.
        }
      });

      for (const dependency of collected.nodes) {
        if (dependency === this) {
          continue;
        }

        this.attachStaticDependency(dependency);
        dependency.onObserve?.();
      }
    } finally {
      setActiveScope(previousScope);
    }
  }

  subscribe(fn: StoreSubscriber<T>): () => void {
    const subscribers = (this.subscribers ??= new Set());
    subscribers.add(fn);
    // A subscription carries no scope, so it observes globally: activate the
    // computed so a dependency change in any scope reaches this subscriber,
    // even a scope the computed was never read in.
    this.onObserve();
    return ownedUnsubscribe(subscriberRemover(subscribers, fn));
  }

  map(mapper: (value: T) => unknown, skipToken: unknown, hasSkipToken: boolean): Store<unknown> {
    return createComputed(
      () => mapper(this.readComputed(undefined, false, true)),
      derivedOptions(skipToken, hasSkipToken, deriveName(this, "map")),
      this,
    );
  }

  filter(predicate: (value: T) => boolean): Store<T> {
    return createComputed(
      () => {
        const value = this.readComputed(undefined, false, true);

        return predicate(value) ? value : (defaultSkipToken as T);
      },
      {
        skipToken: defaultSkipToken as T,
        hasSkipToken: true,
        name: deriveName(this, "filter"),
      },
      this,
    );
  }

  filterMap(mapper: (value: T) => unknown, skipToken: unknown): Store<unknown> {
    return createComputed(
      () => mapper(this.readComputed(undefined, false, true)),
      { skipToken, hasSkipToken: true, name: deriveName(this, "filterMap") },
      this,
    );
  }
}

function runNativeStore(this: NativeStore<unknown>, ctx: KernelExecutionContext): unknown {
  return this.runUpdate(ctx);
}

function runInvalidator(this: ComputedInvalidator<unknown>, ctx: KernelExecutionContext): unknown {
  return this.invalidate(ctx);
}

function runComputed(this: ComputedStore<unknown>, ctx: KernelExecutionContext): unknown {
  return this.runUpdate(ctx);
}

function createComputed<T>(
  fn: () => T,
  options: ComputedOptions<T>,
  staticDependency?: Node,
): Store<T> {
  const core = registerOwnedNode(new ComputedStore(fn, options));
  const invalidator = core.invalidator;
  registerOwnedNode(invalidator);
  if (!core.resolveScope && staticDependency?.resolveScope) {
    core.resolveScope = staticDependency.resolveScope;
    invalidator.resolveScope = core.resolveScope;
  }
  if (staticDependency) core.attachStaticDependency(staticDependency);
  const proxy = core.attach();
  trackComputedDeclaration(core.valueKey, core);
  return proxy as Store<T>;
}

const noMember = Symbol("virentia.noStoreMember");

// One handler for every native store and computed; per-store state lives on the
// target's node.
const storeProxyHandler: ProxyHandler<StoreTarget> = {
  get(target, property, receiver) {
    if (property in target) {
      return Reflect.get(target, property, receiver);
    }
    const core = target[storeCoreKey];
    const member = core.member(property);
    if (member !== noMember) return member;
    if (!(core.flags & STORE_REACTIVE)) {
      // Promise assimilation probes .then after a loader resolves. Unknown
      // API properties must not read scoped state or make stores thenable.
      if (property === "value") return core.readForProxy();
      if (property === nativeStoreApi) return target;
      return property === nativeStoreMode ? "ref" : undefined;
    }

    if (property === nativeStoreApi) return target;
    if (property === nativeStoreMode) return "reactive";

    const state = core.readForProxy();
    return isObject(state) ? Reflect.get(state, property) : undefined;
  },

  set(target, property, value) {
    const core = target[storeCoreKey];
    if (property in target || core.isMember(property)) {
      return false;
    }

    if (!(core.flags & STORE_WRITABLE)) {
      throw new Error("Store is read-only");
    }

    if (!(core.flags & STORE_REACTIVE) && property !== "value") {
      throw new Error("Store value must be written through .value");
    }

    return core.writeProperty(property, value);
  },

  deleteProperty(target, property) {
    if (property in target) {
      return Reflect.deleteProperty(target, property);
    }

    const core = target[storeCoreKey];
    if (core.isMember(property)) return true;

    if (!(core.flags & STORE_WRITABLE)) {
      throw new Error("Store is read-only");
    }

    if (!(core.flags & STORE_REACTIVE)) {
      throw new Error("Store value must be written through .value");
    }

    if (!core.hasStateKey(property)) {
      return true;
    }

    return core.deleteKeyProperty(property);
  },

  defineProperty(target, property, descriptor) {
    const core = target[storeCoreKey];
    if (property in target || core.isMember(property)) {
      return Reflect.defineProperty(target, property, descriptor);
    }

    // Without this trap `Object.defineProperty` would fall through to the shared
    // api target, silently defining a non-reactive, cross-scope-leaking field.
    throw new Error(
      core.flags & STORE_WRITABLE
        ? "Store fields are written through assignment, not defineProperty"
        : "Store is read-only",
    );
  },

  has(target, property) {
    const core = target[storeCoreKey];
    return property in target || core.isMember(property) || core.hasStateKey(property);
  },

  ownKeys(target) {
    // Enumeration exposes the STATE, nothing else. `node`, `subscribe`, `map`,
    // … stay reachable through `get`, but must never land in `Object.keys`,
    // a spread, or `JSON.stringify`: a serialized snapshot would otherwise
    // carry the store's inspector metadata into whatever consumes it (an SSR
    // payload, localStorage), and fail to hydrate back.
    //
    // Omitting them is legal: the api target is a plain object literal, so all
    // of its own properties are configurable, and `ownKeys` only has to report
    // the NON-configurable ones.
    const core = target[storeCoreKey];
    if (!(core.flags & STORE_REACTIVE)) return ["value"];
    const stateKeys = isObject(core.readForProxy())
      ? Reflect.ownKeys(core.readForProxy() as object)
      : [];

    // Dedupe: a state field named like a StoreApi member (e.g. `node`, `map`)
    // would otherwise appear twice, violating the ownKeys proxy invariant
    // ("trap returned duplicate entries") and crashing any enumeration.
    return [...new Set<string | symbol>(stateKeys as (string | symbol)[])];
  },

  getOwnPropertyDescriptor(target, property) {
    const core = target[storeCoreKey];
    // A state key is enumerable even when it shares a name with an api member,
    // so `ownKeys` and this trap agree on what enumeration sees.
    if (core.hasStateKey(property)) {
      return {
        configurable: true,
        enumerable: true,
      };
    }

    if (property in target) {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, property);

      // Reachable, but hidden from enumeration — see `ownKeys`.
      return descriptor ? { ...descriptor, enumerable: false } : undefined;
    }

    if (core.isMember(property)) {
      // API methods read as the own, hidden data properties they used to be.
      return {
        value: core.member(property),
        writable: property !== "sid",
        enumerable: false,
        configurable: true,
      };
    }

    return undefined;
  },
};

function append(source: Node, next: Node): void {
  // Most sources gain one dependent: a literal keeps that array at capacity 1.
  if (source.next) source.next.push(next);
  else source.next = [next];
  topologyChanged();

  registerCleanup(() => {
    const nextNodes = source.next;
    if (!nextNodes) return;

    const index = nextNodes.indexOf(next);

    if (index >= 0) {
      nextNodes.splice(index, 1);
      topologyShrank();
    }
  });
}

function readComputedState<T>(scope: Scope, id: symbol): ComputedState<T> {
  const current = scope.values.get(id) as ComputedState<T> | undefined;
  if (current !== undefined || scope.values.has(id)) return current!;
  const created = new NativeComputedState<T>();
  scope.values.set(id, created);
  return created;
}

function readState<T>(scope: Scope, store: NativeStore<T>): T {
  // Pending writes are staged under the real scope (see writeProperty), while a
  // read inside a reaction body arrives here with the run's micro-scope — unwrap
  // so a read-after-write within one transaction resolves to the same key.
  return readRealState(unwrapMicroScope(scope), store);
}

function readRealState<T>(realScope: Scope, store: NativeStore<T>): T {
  const pending = readStagedStore<T>(store, realScope);

  if (isPendingStoreValue(pending)) {
    return pending as T;
  }

  return readCommittedState(realScope, store.valueKey, store.initial, store.snapshot);
}

function readCommittedState<T>(
  scope: Scope,
  id: symbol,
  initial: T,
  snapshotStore?: SnapshotStore,
): T {
  if (snapshotStore) {
    materializeSnapshotStore(scope, snapshotStore);
  }
  const value = scope.values.get(id);
  if (value !== undefined || scope.values.has(id)) return value as T;
  if (snapshotStore) {
    scope.values.set(id, initial);
    return scope.values.get(id) as T;
  }
  return initial;
}

function assignProperty<T>(state: T, property: PropertyKey, value: unknown): T {
  if (Array.isArray(state)) {
    const next = state.slice();

    Reflect.set(next, property, value);

    return next as T;
  }

  return {
    ...(state as object),
    [property]: value,
  } as T;
}

function removeProperty<T>(state: T, property: PropertyKey): T {
  if (Array.isArray(state)) {
    const next = state.slice();

    Reflect.deleteProperty(next, property);

    return next as T;
  }

  const next = { ...(state as object) };

  Reflect.deleteProperty(next, property);

  return next as T;
}

function isObject(value: unknown): value is object {
  return (typeof value === "object" || typeof value === "function") && value !== null;
}

function deriveName(source: Node, operation: string): string | undefined {
  const name =
    source instanceof StoreCore ? source.inspectorName() : readInspectorNodeMeta(source).name;

  return name ? `${name}.${operation}` : undefined;
}

// ---------------------------------------------------------------------------
// Synchronous propagation of a commit through pure computeds.
//
// When every node a commit reaches is a computed (default runners, no scope
// resolution) or a registered terminal DOM sink, the kernel's drain for it is
// fully predictable. The same breadth-first order, coalescing, comparisons,
// stops and failure containment then run in place, without pages, work items
// or per-item dispatch. Any other node (reaction, effect, custom runner, the
// inspector) keeps the kernel path, decided before anything runs.

let propagationGeneration = 0;

/** An invalidator and computed whose runners still use native propagation. */
function isPureInvalidator(target: ComputedInvalidator<unknown>): boolean {
  if (
    target.run !== runInvalidator ||
    target.resolveScope !== undefined ||
    (target as Node).enabled !== undefined
  )
    return false;
  const computed = target.computed as ComputedStore<unknown>,
    next = target.next;
  return (
    computed.run === runComputed &&
    computed.resolveScope === undefined &&
    (computed as Node).enabled === undefined &&
    next.length === 1 &&
    next[0] === computed
  );
}

let notifyingCommit = 0;
/** A store's subscribers, called before its graph propagation. */
function notifyCommitSubscribers<T>(
  subscribers: Iterable<StoreSubscriber<T>>,
  next: T,
  scope: Scope,
  owner: Node,
): void {
  notifyingCommit++;
  try {
    notifySubscribers(subscribers, next, scope, owner);
  } finally {
    notifyingCommit--;
  }
}

/** Whether a commit may propagate in place at all right now (before any walk). */
function mayPropagateInPlace(): boolean {
  // A write from a commit subscriber inside a drain is queued ahead of the
  // commit's own propagation: their work interleaves in the drain.
  return canPropagateSynchronously() && !(notifyingCommit > 0 && isDrainActive());
}

/** Whether a committed store has anything to notify besides its subscribers. */
function hasGraphObservers(scope: Scope, store: Node): boolean {
  return !!store.next?.length || hasScopedObservers(scope, store);
}

function sinkPriority(node: Node): number {
  return Number.isFinite(node.priority) ? node.priority! : 0;
}

/**
 * The observers an in-place propagation reached from one node in a root scope,
 * in visiting order, with each pure reader's state there. Valid while the
 * scope and the graph's shape (`topologyVersion`) stand: the walk then needs
 * no purity check, no state lookup and no scoped-edge lookup per observer.
 */
class TargetCache {
  constructor(
    readonly scopeId: number,
    readonly version: number,
    // `next` as walked: a list replaced or grown directly invalidates the cache.
    readonly next: Node[] | undefined,
    readonly nextLength: number,
    /** Each observer, then its state if it is a pure reader (else undefined). */
    readonly entries: readonly unknown[],
  ) {}
}

// What a node that reaches nobody remembers: every such node shares it.
const noEntries: readonly unknown[] = [];
// A node without successors found reaching nobody: all such walks at one shape
// in one scope are the same, so they share one cache.
let sharedLeaf: TargetCache | undefined;
function leafCache(scopeId: number, version: number): TargetCache {
  const leaf = sharedLeaf;
  if (leaf !== undefined && leaf.scopeId === scopeId && leaf.version === version) return leaf;
  return (sharedLeaf = new TargetCache(scopeId, version, undefined, 0, noEntries));
}

/**
 * One commit's propagation. Instances are pooled: the pool keeps their hidden
 * class alive across collections, and a reentrant commit takes another one.
 * Used arrays are replaced rather than truncated, so a large propagation does
 * not shrink and regrow the next one's storage.
 * Only the visitor and commit entry points escape this class. Private members
 * let consumer minifiers shorten implementation names without mangling Node APIs.
 */
class Propagation implements ScopedObserverVisitor {
  #scope: Scope = undefined!;
  // The arrays below stay with a pooled propagation: entries past their counts
  // are cleared on release, never truncated (truncation frees the backing store,
  // so the next propagation would allocate it again).
  #sources: Node[] = [];
  #values: unknown[] = [];
  #sourceCount = 0;
  #generation = 0;
  /** Queue entries in kernel order: invalidators, computed updates, FIFO sinks. */
  #nodes: Node[] = [];
  /** Entry whose propagation queued each entry; -1 - i for source i. */
  #parents: number[] = [];
  #nodeCount = 0;
  /** Entries the eligibility walk used, to clear on release. */
  #walked = 0;
  /** Sinks with a positive priority run after all graph work, by priority. */
  #sinks: Node[] | undefined = undefined;
  #sinkParents: number[] | undefined = undefined;
  /** The entry being processed: parent of what it queues. */
  #parent = -1;
  /**
   * Observers that act on a change, in breadth-first order: computeds with
   * subscribers, and sinks with the entry (a computed, or -1 - i for source i)
   * they observe. Each pulls what it observes and runs only if it changed.
   */
  #endpoints: Node[] = [];
  #endpointParents: number[] = [];
  /** For a computed endpoint: whether it had a value when marked (else any value is news). */
  #endpointHadValue: boolean[] = [];
  /** For a computed endpoint: whether its parent is its own entry (see markReader). */
  #endpointOwn: boolean[] = [];
  #endpointCount = 0;
  /** `changeSerial` when the propagation began: a later serial is a change in it. */
  #startSerial = 0;
  /** Sinks already run: one reached from several entries runs once. */
  #ran: Set<Node> | undefined = undefined;

  static take(scope: Scope): Propagation {
    const propagation = propagationPool.pop() ?? new Propagation();
    propagation.#scope = scope;
    return propagation;
  }

  addSource(store: Node, value: unknown): void {
    const index = this.#sourceCount++;
    this.#sources[index] = store;
    this.#values[index] = value;
  }

  #addNode(node: Node, parent: number): void {
    const index = this.#nodeCount++;
    this.#nodes[index] = node;
    this.#parents[index] = parent;
  }

  release(): void {
    this.#scope = undefined!;
    if (this.#sources.length > retainedPropagationSize) {
      this.#sources = [];
      this.#values = [];
    } else
      for (let index = 0; index < this.#sourceCount; index++)
        this.#sources[index] = this.#values[index] = undefined!;
    if (this.#nodes.length > retainedPropagationSize) {
      this.#nodes = [];
      this.#parents = [];
    } else
      for (let index = 0, used = Math.max(this.#nodeCount, this.#walked); index < used; index++)
        this.#nodes[index] = undefined!;
    if (this.#recorded.length > retainedPropagationSize) this.#recorded = [];
    if (this.#endpoints.length > retainedPropagationSize) {
      this.#endpoints = [];
      this.#endpointParents = [];
    } else for (let index = 0; index < this.#endpointCount; index++) this.#endpoints[index] = undefined!;
    this.#endpointCount = 0;
    this.#ran = undefined;
    this.#sourceCount = this.#nodeCount = this.#walked = 0;
    this.#sinks = this.#sinkParents = undefined;
    this.#parent = -1;
    propagationPool.push(this);
  }

  /** Whether everything reachable is pure. Walks the graph, running nothing. */
  pure(): boolean {
    const sources = this.#sources,
      count = this.#sourceCount,
      // Only root scopes are named; others walk every time.
      scopeId = (this.#scope as NativeScope).id ?? 0,
      version = growthVersion;
    let known = scopeId !== 0;
    for (let index = 0; index < count; index++) {
      const source = sources[index] as NativeStore<unknown>;
      if (source.run !== runNativeStore) return false;
      if (source.pureIn !== scopeId || source.pureAt !== version) known = false;
    }
    if (!mayPropagateInPlace()) return false;
    // The graph has not changed shape since a walk found it pure in this scope.
    if (known) return true;
    if (!this.#walkPure()) return false;
    if (scopeId !== 0)
      for (let index = 0; index < count; index++) {
        const source = sources[index] as NativeStore<unknown>;
        source.pureIn = scopeId;
        source.pureAt = version;
      }
    return true;
  }

  #walkPure(): boolean {
    const sources = this.#sources,
      count = this.#sourceCount;
    this.#generation = ++propagationGeneration;
    // The walk's frontier borrows the queue's node array until the queue runs.
    const frontier = this.#nodes;
    for (let index = 0; index < count; index++) frontier[index] = sources[index];
    this.#nodeCount = count;
    try {
      for (let index = 0; index < this.#nodeCount; index++)
        if (!this.#targets(frontier[index])) return false;
      return true;
    } finally {
      if (this.#nodeCount > this.#walked) this.#walked = this.#nodeCount;
      this.#nodeCount = 0;
    }
  }

  /** Visits `node`'s observers in the eligibility walk. */
  #targets(node: Node): boolean {
    const next = node.next;
    if (next)
      for (let index = 0; index < next.length; index++)
        if (!this.#eligible(next[index])) return false;
    return visitScopedObservers(this.#scope, node, this);
  }

  /** `targets`' walk over scoped observers, in the mode it set. */
  visitScopedObserver(observer: Node): boolean {
    if (this.#collecting) {
      // An edge an observed computed kept from a read before its observation
      // repeats a global one, which the walk has just visited.
      if (
        !(
          observer instanceof ComputedInvalidator &&
          (observer.computed.flags & STORE_OBSERVED) !== 0 &&
          observer.computed.hasStaticDependency(this.#collectingFrom!)
        )
      )
        this.#collect(observer);
      return true;
    }
    return this.#eligible(observer);
  }

  #eligible(target: Node): boolean {
    if (target instanceof ComputedInvalidator) {
      if (target.visited === this.#generation) return true;
      if (!isPureInvalidator(target)) return false;
      target.visited = this.#generation;
      this.#nodes[this.#nodeCount++] = target.computed;
      return true;
    }
    return isSynchronousSink(this.#scope, target);
  }

  /** Propagate in place, in a transaction like the kernel drain's; then release. */
  run(): void {
    this.#generation = ++propagationGeneration;
    const previousScope = setActiveScope(this.#scope);
    enterTransaction();
    try {
      this.#drain();
    } finally {
      setActiveScope(previousScope);
      this.release();
      // Writes made by subscribers commit after the whole update.
      exitTransaction();
    }
  }

  /**
   * Marks, then pulls. One breadth-first walk invalidates the direct readers
   * of the written stores, marks the computeds further down for a check and
   * collects the endpoints. Each endpoint then brings what it observes up to
   * date and acts only if it changed: a computed nobody needs is not
   * recomputed, and one whose value stood stops the change there.
   */
  #drain(): void {
    const nodes = this.#nodes,
      sources = this.#sources;
    this.#startSerial = changeSerial;
    markingInPlace = true;
    try {
      for (let index = 0; index < this.#sourceCount; index++) {
        this.#parent = -1 - index;
        this.#collectTargets(sources[index]);
      }
      for (let index = 0; index < this.#nodeCount; index++) {
        this.#parent = index;
        this.#collectTargets(nodes[index]);
      }
    } finally {
      markingInPlace = false;
    }
    for (let index = 0; index < this.#endpointCount; index++)
      this.#runEndpoint(this.#endpoints[index], this.#endpointParents[index], index);
    const sinks = this.#sinks;
    if (sinks) {
      if (sinks.length > 1) {
        const order = sinks.map((_, index) => index);
        order.sort((a, b) => sinkPriority(sinks[a]) - sinkPriority(sinks[b]) || a - b);
        for (const index of order) this.#runEndpoint(sinks[index], this.#sinkParents![index]);
      } else this.#runEndpoint(sinks[0], this.#sinkParents![0]);
    }
  }

  /** Visits `node`'s observers, collecting computeds and endpoints. */
  #collectTargets(node: Node): void {
    const scopeId = (this.#scope as NativeScope).id;
    if (scopeId === undefined || !(node instanceof StoreCore)) {
      this.#collectAll(node);
      return;
    }
    const cache = node.targetCache,
      next = node.next;
    if (
      cache !== undefined &&
      cache.scopeId === scopeId &&
      cache.version === topologyVersion &&
      cache.next === next &&
      cache.nextLength === (next === undefined ? 0 : next.length)
    ) {
      const entries = cache.entries;
      for (let index = 0; index < entries.length; index += 2) {
        const target = entries[index] as Node,
          state = entries[index + 1] as ComputedState<unknown> | undefined;
        // A runner replaced since (no edge moved) takes the checked path.
        if (
          state !== undefined &&
          target.run === runInvalidator &&
          (target as ComputedInvalidator<unknown>).computed.run === runComputed
        )
          this.#markReader(target as ComputedInvalidator<unknown>, state);
        else this.#collect(target);
      }
      return;
    }
    const version = topologyVersion;
    this.#recording = true;
    this.#recordedCount = 0;
    let entries: readonly unknown[];
    try {
      this.#collectAll(node);
      // Sized to what it holds: every node a walk passes remembers one.
      entries = this.#recordedCount === 0 ? noEntries : this.#recorded.slice(0, this.#recordedCount);
    } finally {
      this.#recording = false;
      const recorded = this.#recorded;
      for (let index = 0; index < this.#recordedCount; index++) recorded[index] = undefined;
    }
    node.targetCache =
      entries === noEntries && next === undefined
        ? leafCache(scopeId, version)
        : new TargetCache(scopeId, version, next, next === undefined ? 0 : next.length, entries);
  }

  #collectAll(node: Node): void {
    const next = node.next;
    if (next) for (let index = 0; index < next.length; index++) this.#collect(next[index]);
    this.#collecting = true;
    this.#collectingFrom = node;
    try {
      visitScopedObservers(this.#scope, node, this);
    } finally {
      this.#collecting = false;
      this.#collectingFrom = undefined;
    }
  }

  #collecting = false;
  /** The node whose scoped observers `collectAll` is visiting. */
  #collectingFrom: Node | undefined = undefined;
  /** Whether `collect` records what it visits, for `collectTargets`. */
  #recording = false;
  /** The walk being recorded: observer, state pairs up to `recordedCount`. */
  #recorded: unknown[] = [];
  #recordedCount = 0;

  #collect(target: Node): void {
    if (target instanceof ComputedInvalidator && isPureInvalidator(target)) {
      const state = (target.computed as ComputedStore<unknown>).stateIn(this.#scope);
      if (this.#recording) this.#record(target, state);
      this.#markReader(target, state);
      return;
    }
    if (this.#recording) this.#record(target, undefined);
    this.#collectObserver(target);
  }

  #record(target: Node, state: ComputedState<unknown> | undefined): void {
    this.#recorded[this.#recordedCount++] = target;
    this.#recorded[this.#recordedCount++] = state;
  }

  #markReader(target: ComputedInvalidator<unknown>, state: ComputedState<unknown>): void {
    const parent = this.#parent;
    {
      // A direct reader of a written store is dirty; one further down is
      // marked for a check, which its pull resolves. Whether a value changed
      // is told by its serial (see `changed`), so no pre-change value is kept.
      const computed = target.computed as ComputedStore<unknown>;
      if (parent < 0) {
        if (!sawChangeOf(state, this.#sources[-1 - parent], this.#scope)) state.dirty = true;
      } else if (!(state.dirty || state.check || state.computing) && state.initialized) {
        state.check = true;
        state.checkEpoch = currentUpdateEpoch();
      }
      if (target.visited === this.#generation) return;
      target.visited = this.#generation;
      // A filter keeps the last value it accepted: it sees every update.
      const endpoint = computed.subscribers?.size || computed.options.hasSkipToken;
      // A walk from it reached nobody at this shape: it needs no walk of its
      // own, and as an endpoint it goes by its reader's entry.
      const cache = computed.targetCache;
      if (
        cache !== undefined &&
        cache.entries === noEntries &&
        cache.next === undefined &&
        computed.next === undefined &&
        cache.version === topologyVersion &&
        cache.scopeId === (this.#scope as NativeScope).id
      ) {
        if (endpoint) {
          this.#endpointHadValue[this.#endpointCount] = state.initialized;
          this.#endpointOwn[this.#endpointCount] = false;
          this.#addEndpoint(computed, parent);
        }
        return;
      }
      this.#addNode(computed, parent);
      if (endpoint) {
        this.#endpointHadValue[this.#endpointCount] = state.initialized;
        this.#endpointOwn[this.#endpointCount] = true;
        this.#addEndpoint(computed, this.#nodeCount - 1);
      }
    }
  }

  #collectObserver(target: Node): void {
    const parent = this.#parent;
    // A node the graph changed into since its purity was checked goes to the
    // kernel once what it observes is up to date (see runEndpoint).
    if (sinkPriority(target) > 0) {
      (this.#sinks ??= []).push(target);
      (this.#sinkParents ??= []).push(parent);
    } else this.#addEndpoint(target, parent);
  }

  #addEndpoint(node: Node, parent: number): void {
    const index = this.#endpointCount++;
    this.#endpoints[index] = node;
    this.#endpointParents[index] = parent;
  }

  #runEndpoint(node: Node, parent: number, endpoint = -1): void {
    if (node instanceof ComputedStore) {
      const hadValue = endpoint < 0 || this.#endpointHadValue[endpoint];
      // `parent` is its own entry, or that of its reader if it has none.
      const own = endpoint < 0 || this.#endpointOwn[endpoint];
      const state = node.stateIn(this.#scope);
      if (!this.#changed(node, parent, state, own) && (hadValue || !state.initialized || state.skipped))
        return;
      const subscribers = node.subscribers;
      if (!subscribers?.size) return;
      const shape = topologyVersion;
      notifySubscribers(subscribers, state.value, this.#scope, node);
      // Its subscribers may attach observers to it: those get this change too.
      if (shape !== topologyVersion) {
        if (!own) {
          this.#addNode(node, parent);
          parent = this.#nodeCount - 1;
        }
        this.#handOffGained(node, parent);
      }
      return;
    }
    // A sink acts on a change of what it observes, once.
    if (parent >= 0) {
      const observed = this.#nodes[parent] as ComputedStore<unknown>;
      if (!this.#changed(observed, parent, observed.stateIn(this.#scope), true)) return;
    }
    const ran = (this.#ran ??= new Set());
    if (ran.has(node)) return;
    ran.add(node);
    this.#parent = parent;
    if (isSynchronousSink(this.#scope, node)) this.#runSink(node, parent);
    else this.#handOff(node);
  }

  /** Hands the observers `computed` gained during its update over to the kernel. */
  #handOffGained(computed: ComputedStore<unknown>, entry: number): void {
    const gained: Node[] = [];
    const next = computed.next;
    if (next) for (let index = 0; index < next.length; index++) gained.push(next[index]);
    visitScopedObservers(this.#scope, computed, {
      visitScopedObserver(observer: Node): boolean {
        gained.push(observer);
        return true;
      },
    });
    this.#parent = entry;
    for (const target of gained) {
      if (target instanceof ComputedInvalidator) {
        if (target.visited !== this.#generation) this.#handOff(target);
        continue;
      }
      if (this.#ran?.has(target)) continue;
      let collected = false;
      for (let index = 0; index < this.#endpointCount && !collected; index++)
        collected = this.#endpoints[index] === target;
      if (collected || this.#sinks?.includes(target)) continue;
      (this.#ran ??= new Set()).add(target);
      this.#handOff(target);
    }
  }

  /**
   * Brings `computed` (its `state`) up to date; whether its value changed in
   * this propagation. `entry` is its own, or its reader's unless `own`.
   */
  #changed(
    computed: ComputedStore<unknown>,
    entry: number,
    state: ComputedState<unknown>,
    own: boolean,
  ): boolean {
    enterPropagationStep(computed);
    try {
      computed.evaluate(this.#scope, state);
      return state.changedSerial > this.#startSerial && !state.skipped;
    } catch (error) {
      containPropagationFailure(error, own ? this.#itemOf(entry) : this.#itemOf(entry, computed));
      return false;
    } finally {
      exitPropagationStep();
    }
  }

  /** A subscriber changed the graph mid-update: the kernel takes the new node. */
  #handOff(target: Node): boolean {
    runDetached({ unit: target, scope: this.#scope, payload: this.#valueOf(this.#parent) });
    return true;
  }

  #valueOf(entry: number): unknown {
    if (entry < 0) return this.#values[-1 - entry];
    const node = this.#nodes[entry];
    return node instanceof ComputedStore ? node.stateIn(this.#scope).value : undefined;
  }

  #runSink(sink: Node, parent: number): void {
    enterPropagationStep(sink);
    try {
      runSynchronousSink(sink);
    } catch (error) {
      containPropagationFailure(error, this.#itemOf(parent, sink));
    } finally {
      exitPropagationStep();
    }
  }

  /** A work-item chain for failure reports: the propagation path to `entry`. */
  #itemOf(entry: number, sink?: Node): KernelWorkItem {
    const chain: Node[] = [];
    if (sink) chain.push(sink);
    let index = entry;
    for (; index >= 0; index = this.#parents[index]) chain.push(this.#nodes[index]);
    chain.push(this.#sources[-1 - index]);
    let item: KernelWorkItem | undefined;
    for (let at = chain.length - 1; at >= 0; at--)
      item = { node: chain[at], scope: this.#scope, parent: item } as KernelWorkItem;
    return item!;
  }
}

// A pooled propagation keeps arrays up to this size between uses.
const retainedPropagationSize = 1024;
const propagationPool: Propagation[] = [];

/** A single store's commit, in place when its graph is pure; false for the kernel. */
function propagateCommit(scope: Scope, store: Node, value: unknown): boolean {
  if (!hasGraphObservers(scope, store)) return !isInspectorEnabled();
  if (store.run !== runNativeStore || !mayPropagateInPlace()) return false;
  const propagation = Propagation.take(scope);
  propagation.addSource(store, value);
  if (!propagation.pure()) {
    propagation.release();
    return false;
  }
  propagation.run();
  return true;
}

// An idle drain commits its staged native stores together. The kernel would
// notify every subscriber and then drain one breadth-first queue for all of
// them: when the whole graph is pure, do exactly that in place.
/** The native store a committed (changed, native) write belongs to. */
function storeOfWrite(write: PendingStoreWrite): NativeStore<unknown> {
  return (write.target as NativeStoreTransactionTarget<unknown>).store as NativeStore<unknown>;
}

// `writes` are a commit's writes in one scope; only the changed ones publish.
setNativeBatchPublisher((scope, writes) => {
  if (!isDrainCommitting()) return false;
  let observed = false;
  for (const write of writes)
    if (write.changed && hasGraphObservers(scope, storeOfWrite(write))) {
      observed = true;
      break;
    }
  let propagation: Propagation | undefined;
  if (observed) {
    propagation = Propagation.take(scope);
    for (const write of writes)
      if (write.changed) propagation.addSource(storeOfWrite(write), write.value);
  }
  const pure = propagation?.pure() ?? false;
  // As notifyCommitSubscribers, once for them all.
  notifyingCommit++;
  try {
    for (const write of writes) {
      if (!write.changed) continue;
      const store = storeOfWrite(write);
      if (store.subscribers?.size) notifySubscribers(store.subscribers, write.value, scope, store);
    }
  } finally {
    notifyingCommit--;
  }
  if (!propagation) return true;
  // Subscribers may have changed the graph: check again before running. In a
  // drain, a kernel launch only queues the work; the order of launches is kept.
  if (pure && propagation.pure()) propagation.run();
  else {
    propagation.release();
    for (const write of writes)
      if (write.changed) storeOfWrite(write).launchGraph(scope, write.value);
  }
  return true;
});

// Every store and computed may die between two bursts of work: keep the hidden
// classes optimized store code depends on (see kernel/shapes.ts).
setStoreObservationHooks(isNativeStoreUnit, initializeScopedComputed);
retainShapes(
  "core/units/store",
  new NativeStore(undefined, { writable: true, mode: "ref", hasSkipToken: false }, undefined),
  new ComputedStore(() => undefined, { hasSkipToken: false }),
  new CommittedStoreUpdate(undefined),
  new StoreExtras(),
);
