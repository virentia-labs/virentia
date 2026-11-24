import type {
  KernelContext,
  KernelContextManager,
  KernelExecutionContext,
  RunOptions,
} from "./types";
import { retainShapes } from "./shapes";
import type { Node } from "./types";
import type { Scope } from "../scope/types";
import type { CreatePageOptions, KernelWorkItem, Page } from "./internal";
import { getActiveScope, setActiveScope } from "../scope/internal";
import { retainScopeTask } from "../scope/tasks";
import { markErrorReported, reportContainedError, wasErrorReported } from "./report";
import { unwrapMicroScope } from "../scope/micro";
import {
  describeNode,
  emitInspectorBreakpointHit,
  emitInspectorNodeEnd,
  emitInspectorNodeStart,
  inspectorNow,
  isInspectorEnabled,
  registerInspectorScope,
  shouldStopAfterInspectorNode,
} from "./inspector";
import {
  activeTransactionDepth,
  commitActiveTransaction,
  enterTransaction,
  exitTransaction,
  isPublishingSeveral,
} from "./transaction";
import {
  hasScopedObservers,
  visitScopedObservers,
  type ScopedObserverVisitor,
} from "./scoped-edges";
import { popNodeFrame, pushNodeFrame } from "./call-stack";
import { scopePromise } from "../scope/promise";
import { getOwner, type Owner } from "../graph/owner";
import { topologyChanged } from "./topology";
import { setKernelReadBoundary } from "../graph/deps";

let nextPageId = 0;
let nextImplicitNodeId = 0;
let activeDrain: DrainContext | null = null;
let runningNodeDepth = 0;
// A node `run` that reads nothing of its context but the scope and the value,
// and the same run given just those (see runTargetsDirectly).
let directRun: Node["run"] | undefined;
let runDirect: ((node: Node, scope: Scope | null, value: unknown) => unknown) | undefined;
// The target a direct run parked: the item the drain resumes after.
let parkedTarget: KernelWorkItem | undefined;

/**
 * @internal Lets the kernel run nodes whose `run` is `run` straight from their
 * source's propagation, through `direct`, when nothing else is queued.
 */
export function registerDirectRun(
  run: NonNullable<Node["run"]>,
  direct: (node: Node, scope: Scope | null, value: unknown) => unknown,
): void {
  directRun = run;
  runDirect = direct;
}
// Set while a drain commits the writes of the queue it has just emptied.
let drainCommitting = false;
const synchronousSink = Symbol("virentia.synchronousSink");
const synchronousMethodSink = Symbol("virentia.synchronousMethodSink");
type TerminalNode = Node & { [synchronousSink]?: () => void; [synchronousMethodSink]?: boolean };
const frozenSinks = new WeakMap<Node, { update: () => void; method: boolean }>();
let hasFrozenSinks = false;

/** @internal Pure terminal DOM writes only: no user callbacks or graph mutations. */
export function registerSynchronousSink(node: Node, update: () => void): void {
  topologyChanged();
  try {
    (node as TerminalNode)[synchronousSink] = update;
    if ((node as TerminalNode)[synchronousMethodSink])
      (node as TerminalNode)[synchronousMethodSink] = false;
  } catch {
    hasFrozenSinks = true;
    frozenSinks.set(node, { update, method: false });
  }
}

/** @internal A terminal implemented by shared prototype methods keeps its receiver. */
export function registerSynchronousMethodSink(node: Node & { run(): void }): void {
  topologyChanged();
  try {
    (node as TerminalNode)[synchronousSink] = node.run;
    (node as TerminalNode)[synchronousMethodSink] = true;
  } catch {
    hasFrozenSinks = true;
    frozenSinks.set(node, { update: node.run, method: true });
  }
}

/**
 * @internal A commit may propagate synchronously when no drain is running, or
 * when the running drain is idle (its queue is empty and no node is running):
 * nothing else could have been ordered before the propagation.
 */
export function canPropagateSynchronously(): boolean {
  if (isInspectorEnabled()) return false;
  const drain = activeDrain;
  // In a drain, one store published by itself could only be queued next. Of
  // several, the earlier ones' work may already wait in the queue.
  return (
    !drain ||
    (drainCommitting &&
      runningNodeDepth === 0 &&
      drain.head >= drain.queue.length &&
      !isPublishingSeveral())
  );
}

/** @internal Whether a drain is running (or committing) right now. */
export function isDrainActive(): boolean {
  return activeDrain !== null;
}

/** @internal Whether the current commit is an idle drain's end-of-queue commit. */
export function isDrainCommitting(): boolean {
  return activeDrain !== null && drainCommitting && runningNodeDepth === 0;
}

/**
 * @internal A failure inside a synchronous propagation is contained like a
 * propagated work item's: reported, and failing the idle drain (if any) whose
 * commit started the propagation, so an awaited trigger still rejects.
 */
export function containPropagationFailure(error: unknown, item: KernelWorkItem): void {
  reportContainedError(error, { kind: "reaction", item });
  if (activeDrain) (activeDrain.errors ??= []).push(error);
}

/** @internal Open `node`'s kernel frame for a synchronous propagation step. */
export function enterPropagationStep(node: Node): void {
  runningNodeDepth++;
  pushNodeFrame(node);
}

/** @internal Close the frame opened by enterPropagationStep. */
export function exitPropagationStep(): void {
  popNodeFrame();
  runningNodeDepth--;
}

/** @internal Whether a node is a registered terminal DOM write for `scope`. */
export function isSynchronousSink(scope: Scope, observer: Node): boolean {
  const frozen = hasFrozenSinks ? frozenSinks.get(observer) : undefined;
  const update = frozen?.update ?? (observer as TerminalNode)[synchronousSink];
  return !(
    !update ||
    observer.run !== update ||
    observer.enabled !== undefined ||
    observer.next?.length ||
    hasScopedObservers(scope, observer)
  );
}

/** @internal Run a registered terminal sink (see isSynchronousSink). */
export function runSynchronousSink(observer: Node): void {
  const frozen = hasFrozenSinks ? frozenSinks.get(observer) : undefined;
  if (frozen ? frozen.method : (observer as TerminalNode)[synchronousMethodSink])
    (observer as { run(): void }).run();
  else (frozen?.update ?? (observer as TerminalNode)[synchronousSink])!();
}

/** @internal A single scoped edge already names its only terminal consumer. */
export function trySynchronousObserver(scope: Scope, observer: Node): boolean {
  if (activeDrain || activeTransactionDepth() || isInspectorEnabled()) return false;
  const frozen = hasFrozenSinks ? frozenSinks.get(observer) : undefined;
  const update = frozen?.update ?? (observer as TerminalNode)[synchronousSink];
  if (
    !update ||
    observer.run !== update ||
    observer.enabled !== undefined ||
    observer.next?.length ||
    hasScopedObservers(scope, observer)
  )
    return false;
  try {
    runningNodeDepth++;
    if (frozen ? frozen.method : (observer as TerminalNode)[synchronousMethodSink])
      (observer as { run(): void }).run();
    else update();
  } catch (error) {
    reportContainedError(error, { kind: "reaction", subject: describeNode(observer) });
  } finally {
    runningNodeDepth--;
  }
  return true;
}
// When a scope task (`scoped`) is collecting the async work it spawns, each
// top-level async run registers its settle promise with the innermost task so
// the task can await everything it triggered before tearing its scope down.
// A task is identified by a number (read boundaries compare it) and its list
// is allocated by its first spawn: a synchronous task allocates nothing.
let spawnTask = 0;
let lastSpawnTask = 0;
let spawned: Promise<void>[] | undefined;
// The enclosing tasks' ids and lists, innermost last.
const spawnTasks: (number | Promise<void>[] | undefined)[] = [];
setKernelReadBoundary({
  get depth() {
    return runningNodeDepth;
  },
  get task() {
    return spawnTask;
  },
});

/**
 * @internal Starts collecting the settle promises of top-level async runs (for
 * the synchronous body of a scope task). Every call is paired with exactly one
 * `closeSpawnCollection()`, innermost first.
 */
export function openSpawnCollection(): void {
  spawnTasks.push(spawnTask, spawned);
  spawnTask = ++lastSpawnTask;
  spawned = undefined;
}

/** @internal Restores the enclosing collection; returns what this one gathered, if anything. */
export function closeSpawnCollection(): Promise<void>[] | undefined {
  const collected = spawned;
  spawned = spawnTasks.pop() as Promise<void>[] | undefined;
  spawnTask = spawnTasks.pop() as number;
  return collected;
}

/**
 * Starts collecting the settle promises of top-level async runs spawned while the
 * returned `stop` callback has not been called yet (i.e. during the synchronous
 * body of a scope task). `stop()` restores the previous collector and returns the
 * gathered promises. Used by `scoped` to wait for the reactions/effects a body
 * triggered before restoring the ambient scope, so nothing detached outlives it.
 */
export function beginSpawnCollection(): () => Promise<void>[] {
  openSpawnCollection();
  return () => closeSpawnCollection() ?? [];
}

interface FlushWaiter {
  resolve(): void;
  reject(error: unknown): void;
}

// Most drains run one launch to the end with nothing failed, awaited or
// pending: their lists are created on first use.
interface DrainContext {
  // Failures contained mid-drain. Independent branches finish first; the drain
  // then fails with them, so the caller awaiting `run()` still learns about it.
  errors: unknown[] | undefined;
  queue: KernelWorkItem[];
  // Almost every node has just one pending scope/key. Keep that case allocation-
  // free; only a collision needs the nested scope/key table.
  // Created on the first collision; node slots hold the common single item.
  slots:
    | Map<Node, KernelWorkItem | Map<object | null, Map<PropertyKey, KernelWorkItem>>>
    | undefined;
  waiters: FlushWaiter[] | undefined;
  pending: Promise<void>[] | undefined;
  head: number;
}

export const rootPage = createPage();
export let currentPage: Page = rootPage;

/** A launch's page: a child of the current one (createPage without an options object). */
function createChildPage(contexts: Iterable<KernelContext> | undefined): Page {
  const page: Page = {
    id: ++nextPageId,
    parent: currentPage,
    contextMap: undefined,
  };

  if (contexts) {
    for (const context of contexts) {
      (page.contextMap ??= new Map()).set(context.id, context.value);
    }
  }

  return page;
}

export function createPage(options?: CreatePageOptions): Page {
  const page: Page = {
    id: ++nextPageId,
    parent: options?.parent ?? null,
    contextMap: undefined,
  };

  if (options?.contexts) {
    for (const context of options.contexts) {
      (page.contextMap ??= new Map()).set(context.id, context.value);
    }
  }

  return page;
}

export function setCurrentPage(page: Page): void {
  currentPage = page;
}

export function readPageContext<T>(
  page: Page,
  context: KernelContextManager<T> | symbol,
  fallback?: T,
): T {
  const id = typeof context === "symbol" ? context : context.id;
  let cursor: Page | null = page;

  while (cursor) {
    const value = cursor.contextMap?.get(id);
    if (value !== undefined || cursor.contextMap?.has(id)) return value as T;

    cursor = cursor.parent;
  }

  return fallback as T;
}

export function writePageContext<T>(
  page: Page,
  context: KernelContextManager<T> | symbol,
  value: T,
): void {
  const id = typeof context === "symbol" ? context : context.id;
  (page.contextMap ??= new Map()).set(id, value);
}

function createDrainContext(): DrainContext {
  return {
    errors: undefined,
    queue: [],
    slots: undefined,
    waiters: undefined,
    pending: undefined,
    head: 0,
  };
}

function push(context: DrainContext, item: KernelWorkItem): void {
  if (item.scope && item.node.resolveScope) item.scope = item.node.resolveScope(item.scope);
  const enabled = item.node.enabled;

  if (typeof enabled === "function" ? !enabled() : enabled === false) {
    return;
  }

  if (item.batchKey !== undefined) {
    const node = item.node as SlottedNode;
    node.id ??= ++nextImplicitNodeId;
    const slot = node[queuedSlot];
    if (slot !== undefined && slot.slotOf === context) {
      if (slot.scope === item.scope && slot.batchKey === item.batchKey) {
        slot.payload = item.payload;
        slot.value = item.value;
        slot.error = item.error;
        slot.failed = item.failed;
        slot.meta = item.meta;
        return;
      }
    } else if (
      slot === undefined &&
      !context.slots?.size &&
      item instanceof WorkItem &&
      claimSlot(node, item, context)
    ) {
      enqueue(context, item);
      return;
    }
    const batched = (context.slots ??= new Map());
    const entry = batched.get(item.node);
    let queued: KernelWorkItem | undefined;
    if (entry instanceof Map) {
      let keys = entry.get(item.scope);
      if (!keys) entry.set(item.scope, (keys = new Map()));
      queued = keys.get(item.batchKey);
      if (!queued) keys.set(item.batchKey, item);
    } else if (entry) {
      if (entry.scope === item.scope && entry.batchKey === item.batchKey) queued = entry;
      else {
        const scopes = new Map<object | null, Map<PropertyKey, KernelWorkItem>>();
        scopes.set(entry.scope, new Map([[entry.batchKey!, entry]]));
        let keys = scopes.get(item.scope);
        if (!keys) scopes.set(item.scope, (keys = new Map()));
        keys.set(item.batchKey, item);
        batched.set(item.node, scopes);
      }
    } else batched.set(item.node, item);

    if (queued) {
      queued.payload = item.payload;
      queued.value = item.value;
      queued.error = item.error;
      queued.failed = item.failed;
      queued.meta = item.meta;
      return;
    }
  }

  enqueue(context, item);
}

function enqueue(context: DrainContext, item: KernelWorkItem): void {
  const queue = context.queue;
  const priority = nodePriority(item.node);
  // Preserve the ordinary kernel's O(1) FIFO enqueue. Renderers can opt into
  // later phases, so fresh graph propagation (priority 0) precedes pending DOM
  // work, and structural parents precede bindings owned by their descendants.
  if (
    context.head === queue.length ||
    nodePriority(queue[queue.length - 1].node) <= priority
  ) {
    queue.push(item);
    return;
  }

  let low = context.head;
  let high = queue.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    // Insert AFTER existing work at the same priority to retain FIFO ties,
    // including work launched or propagated while this drain is in progress.
    if (nodePriority(queue[middle].node) <= priority) low = middle + 1;
    else high = middle;
  }
  queue.splice(low, 0, item);
}

function nodePriority(node: Node): number {
  return Number.isFinite(node.priority) ? node.priority! : 0;
}

// A batched item claims this slot on its node while queued, so finding the item
// to coalesce into needs no Map lookup (and no allocation) in the common case of
// one pending item per node. Collisions fall back to `DrainContext.slots`.
/** @internal Node classes declare this slot so claiming it never changes their shape. */
export const queuedSlot = Symbol("virentia.queuedItem");
type SlottedNode = Node & { [queuedSlot]?: WorkItem };

/**
 * One shape for every queued item keeps the drain loop's field loads
 * monomorphic. A dequeued item is also the execution context of its node's
 * run: the context starts from the item's own fields and its methods live on
 * the prototype, so running a node allocates nothing besides what it queues.
 */
class WorkItem implements KernelWorkItem, KernelExecutionContext {
  error: unknown = undefined;
  failed = false;
  stopped = false;
  /** The drain whose node slot this item holds. */
  slotOf: DrainContext | undefined = undefined;
  /** The drain running this item: where its context launches units. */
  drain: DrainContext | undefined = undefined;
  constructor(
    public node: Node,
    public page: Page,
    public scope: Scope | null,
    public payload: unknown,
    public value: unknown,
    public meta: Record<string, unknown>,
    public batchKey: PropertyKey | undefined,
    public propagated: boolean,
    public parent: KernelWorkItem | undefined,
  ) {}
  stop(): void {
    this.stopped = true;
  }
  fail(error: unknown = this.value): void {
    this.error = error;
    this.failed = true;
    this.stopped = true;
  }
  launch(unit: Node | readonly Node[], value: unknown = this.value): void {
    const drain = this.drain!;
    if (!Array.isArray(unit)) {
      push(
        drain,
        new WorkItem(
          unit as Node,
          this.page,
          this.scope,
          value,
          value,
          this.meta,
          this.batchKey,
          false,
          undefined,
        ),
      );
      return;
    }
    for (const nextNode of unit as readonly Node[])
      push(
        drain,
        new WorkItem(
          nextNode,
          this.page,
          this.scope,
          value,
          value,
          this.meta,
          this.batchKey,
          false,
          undefined,
        ),
      );
  }
  getContext<T>(context: KernelContextManager<T>): T {
    return readPageContext(this.page, context);
  }
  setContext<T>(context: KernelContextManager<T>, value: T): void {
    writePageContext(this.page, context, value);
  }
}

// Optimized drain code embeds this class's final hidden class: keep it (see
// kernel/shapes.ts).
retainShapes(
  "core/kernel/run",
  new WorkItem({}, rootPage, null, undefined, undefined, {}, undefined, false, undefined),
);

export async function run(options: RunOptions): Promise<void> {
  return launch(options, false);
}

/** @internal Callables need one context-carrying promise, not an async wrapper first. */
export function runScoped(
  options: RunOptions,
  ambient: Scope | null,
  owner: Owner | null = getOwner(),
): Promise<void> {
  let settled: Promise<void> | void;
  try {
    settled = launch(options, false);
  } catch (error) {
    settled = Promise.reject(error);
  }
  return scopePromise(settled, ambient, owner);
}

/** @internal `runScoped` for a unit call: one unit, no contexts, batch key or metadata. */
export function runUnitScoped(
  unit: Node,
  scope: Scope | null,
  payload: unknown,
  ambient: Scope | null,
  owner: Owner | null = getOwner(),
): Promise<void> {
  let settled: Promise<void> | void;
  try {
    settled = launchUnit(unit, scope, payload);
  } catch (error) {
    settled = Promise.reject(error);
  }
  return scopePromise(settled, ambient, owner);
}

function launch(options: RunOptions, detached: boolean): Promise<void> | void {
  const page = createChildPage(options.contexts);
  // Units always run in a real scope. A micro-scope is only a tracking overlay
  // for a reaction body, so effects/propagation resolve to its real parent —
  // reads inside an effect then never leak into the reaction's dependencies.
  const scope = unwrapMicroScope(options.scope ?? getActiveScope());

  registerInspectorScope(scope);

  const drain = activeDrain && runningNodeDepth === 0 ? activeDrain : createDrainContext();
  const unit = options.unit,
    payload = options.payload,
    meta = options.meta ?? {};

  if (!Array.isArray(unit))
    push(
      drain,
      new WorkItem(
        unit as Node,
        page,
        scope,
        payload,
        payload,
        meta,
        options.batchKey,
        false,
        undefined,
      ),
    );
  else
    for (const node of unit as readonly Node[])
      push(
        drain,
        new WorkItem(node, page, scope, payload, payload, meta, options.batchKey, false, undefined),
      );

  return startDrain(drain, detached);
}

/** `launch` of one unit without options (a unit call): no options object to build. */
function launchUnit(unit: Node, scope: Scope | null, payload: unknown): Promise<void> | void {
  const page = createChildPage(undefined);
  const real = unwrapMicroScope(scope ?? getActiveScope());

  registerInspectorScope(real);

  const drain = activeDrain && runningNodeDepth === 0 ? activeDrain : createDrainContext();
  push(drain, new WorkItem(unit, page, real, payload, payload, {}, undefined, false, undefined));

  return startDrain(drain, false);
}

/** Runs a launch's freshly queued items: joins the active drain, or drains now. */
function startDrain(drain: DrainContext, detached: boolean): Promise<void> | void {
  if (activeDrain && runningNodeDepth === 0) {
    // Store commits already belong to this drain. Its caller owns completion
    // and failures; a detached notification needs neither a waiter nor a Promise.
    return detached ? undefined : waitForDrain(activeDrain);
  }

  if (activeDrain && runningNodeDepth > 0) {
    const parentDrain = activeDrain;
    // A reentrant drain must leave the caller's ambient scope/page untouched
    // (like the top-level branch below): an async node inside the drain
    // synchronously nulls the active scope and restores it only in a later
    // microtask, so without this the synchronous caller would be left with
    // scope=null and the next unit call would throw "Scope is required".
    const previousPage = currentPage;
    const previousScope = getActiveScope();

    try {
      const result = drainQueue(drain);

      if (isPromiseLike(result)) {
        (parentDrain.pending ??= []).push(result);
      }

      return result;
    } finally {
      currentPage = previousPage;
      setActiveScope(previousScope);
    }
  }

  const previousPage = currentPage;
  const previousScope = getActiveScope();
  let result: Promise<void> | void;

  try {
    result = drainQueue(drain);
  } finally {
    // Restore the caller's synchronous frame as soon as the synchronous portion of
    // the drain yields — in a `finally` so a SYNCHRONOUS throw from the drain (a
    // sync node body / auto-reaction throwing) still restores it, instead of
    // leaving the firing scope installed as the global ambient after the rejected
    // run.
    currentPage = previousPage;
    setActiveScope(previousScope);
  }

  if (isPromiseLike(result)) {
    // Register with an active scope-task collector so `scoped` can await this
    // spawned work (and everything it transitively drains) before tearing down.
    if (spawnTask !== 0) (spawned ??= []).push(result as Promise<void>);

    return result;
  }
}

/**
 * Fire-and-forget launch for updates the library itself initiates: a store
 * commit notifying its graph, a reaction's creation pass, effect bookkeeping.
 * Nobody awaits these, so a rejection of the `run()` promise would escape as an
 * unhandled rejection and take the process down — while the failure itself was
 * (for a propagated item) already delivered through the contained-error funnel.
 * Absorb what was already reported; report what would otherwise vanish unseen.
 */
export function runDetached(options: RunOptions): void {
  try {
    const result = launch(options, true);
    if (result) result.catch((error: unknown) => reportDetachedError(options, error));
  } catch (error) {
    reportDetachedError(options, error);
  }
}

function reportDetachedError(options: RunOptions, error: unknown): void {
  if (wasErrorReported(error)) return;
  const unit = Array.isArray(options.unit) ? options.unit[0] : options.unit;
  reportContainedError(error, {
    kind: "detached update",
    subject: unit ? describeNode(unit) : undefined,
  });
}

function drainQueue(drain: DrainContext): Promise<void> | void {
  const previousDrain = activeDrain;

  activeDrain = drain;

  return continueDrain(drain, previousDrain);
}

// Every asynchronous graph continuation owns only its synchronous frame. A
// deferred global reset in Promise.finally can overwrite another unit's await
// handoff between its resolve callback and the user's native continuation.
function resumeDrain(drain: DrainContext): Promise<void> | void {
  const page = currentPage,
    scope = getActiveScope(),
    resumed = activeDrain;
  activeDrain = drain;
  try {
    return continueDrain(drain, resumed);
  } finally {
    currentPage = page;
    setActiveScope(scope);
  }
}

// The asynchronous continuations live in their own functions: a closure in
// continueDrain itself would make every (synchronous) drain allocate its context.
function resumeAfterItem(
  result: PromiseLike<unknown>,
  drain: DrainContext,
  item: KernelWorkItem,
): Promise<void> {
  return (result as Promise<unknown>).then(
    () => {
      // On asynchronous resume the synchronous caller that owned
      // `previousDrain` is long gone. Restore whatever drain is active
      // now (usually none) instead of re-installing a parked parent:
      // otherwise a unit call in a later handler continuation would see
      // that parked drain, join it via `waitForDrain`, and deadlock —
      // the drain only settles once the handler finishes, and the
      // handler is blocked on the very call that joined it.
      return resumeDrain(drain);
    },
    (error) => {
      if (!item.propagated) {
        releaseQueuedSlots(drain);
        settleFlushWaiters(drain, true, error);
        throw error;
      }

      reportContainedError(error, { kind: "async reaction", item });
      (drain.errors ??= []).push(error);
      return resumeDrain(drain);
    },
  );
}

function resumeAfterPending(pending: Promise<void>[], drain: DrainContext): Promise<void> {
  return Promise.all(pending).then(
    () => {
      // See resumeAfterItem: restore the drain active at resume time, not
      // the parked `previousDrain` captured when this drain started.
      return resumeDrain(drain);
    },
    (error) => {
      releaseQueuedSlots(drain);
      settleFlushWaiters(drain, true, error);
      throw error;
    },
  );
}

function continueDrain(
  drain: DrainContext,
  previousDrain: DrainContext | null,
): Promise<void> | void {
  try {
    // The queue and `pending` (promises from reentrant async runs, e.g. a
    // fire-and-forget effect launched inside an async reaction body) must both
    // reach empty before the drain settles. `pending` is checked on every pass —
    // including when the queue is already empty on re-entry after an async node
    // resolves — otherwise a dangling reentrant promise would be silently
    // dropped and a `scoped(...)` awaiting the drain would resolve early.
    while (drain.head < drain.queue.length || drain.pending?.length) {
      if (drain.head < drain.queue.length) {
        enterTransaction();

        while (drain.head < drain.queue.length) {
          const item = drain.queue[drain.head++];

          if ((item as WorkItem).slotOf !== undefined) releaseSlot(item as WorkItem);
          else if (item.batchKey !== undefined) {
            const batched = drain.slots!;
            const entry = batched.get(item.node);
            if (entry instanceof Map) {
              const keys = entry.get(item.scope);
              keys?.delete(item.batchKey);
              if (!keys?.size) entry.delete(item.scope);
              if (!entry.size) batched.delete(item.node);
            } else batched.delete(item.node);
          }

          let result: ReturnType<typeof processItem>;

          // A throwing node stops its OWN branch: `processItem` bails before
          // enqueuing anything downstream, so nothing past the failure runs. The
          // remaining queue belongs to independent branches of the same update
          // and must still drain, so the error is reported rather than rethrown.
          try {
            result = processItem(drain, item);
          } catch (error) {
            if (!item.propagated) throw error;

            reportContainedError(error, { kind: "reaction", item });
            (drain.errors ??= []).push(error);
            continue;
          }

          if (isPromiseLike(result)) {
            exitTransaction();
            activeDrain = previousDrain;
            // A target its source ran directly parked rather than the source.
            const parked = parkedTarget ?? item;
            parkedTarget = undefined;

            return resumeAfterItem(result, drain, parked);
          }
        }

        drain.head = 0;
        drain.queue.length = 0;
        const committing = drainCommitting;
        drainCommitting = true;
        try {
          exitTransaction();
        } finally {
          drainCommitting = committing;
        }
      }

      if (drain.pending?.length) {
        const pending = drain.pending.splice(0);

        activeDrain = previousDrain;

        return resumeAfterPending(pending, drain);
      }
    }
  } catch (error) {
    releaseQueuedSlots(drain);
    exitTransaction();
    activeDrain = previousDrain;
    settleFlushWaiters(drain, true, error);
    throw error;
  }

  // Every branch has now run. If any of them failed, the update as a whole did
  // fail — surface it to whoever is awaiting this run rather than leaving the
  // failure in the log alone.
  if (drain.errors?.length) {
    const [first, ...rest] = drain.errors;
    const failure =
      rest.length === 0
        ? first
        : new AggregateError(drain.errors, "Multiple reactions failed");

    // The members were each reported as they were contained; the aggregate
    // wrapper wraps only reported failures, so a detached launch may absorb it.
    markErrorReported(failure);
    drain.errors.length = 0;
    activeDrain = previousDrain;
    settleFlushWaiters(drain, true, failure);
    throw failure;
  }

  activeDrain = previousDrain;
  settleFlushWaiters(drain, false, undefined);
}

function processItem(drain: DrainContext, item: KernelWorkItem): Promise<void> | void {
  const node = item.node;
  const inspected = isInspectorEnabled();
  if (!node.run && !inspected) {
    // Events and routing nodes only forward their payload. No handler can use
    // an execution context here, so avoid allocating its methods and closures.
    currentPage = item.page;
    setActiveScope(item.scope);
    if (directRun !== undefined && drain.head === drain.queue.length) {
      const next = item.node.next;
      if (next !== undefined && next.length > 0 && runsDirectly(item, next))
        return runTargetsDirectly(drain, item, next);
    }
    propagateItem(drain, item, item);
    return;
  }
  const ctx = item as WorkItem;
  ctx.drain = drain;

  currentPage = item.page;
  setActiveScope(item.scope);

  const startedAt = inspected ? inspectorNow() : 0;

  if (inspected) {
    emitInspectorNodeStart({
      node,
      scope: item.scope,
      payload: item.payload,
      value: item.value,
      meta: item.meta,
      timestamp: startedAt,
    });
  }

  try {
    runningNodeDepth += 1;

    try {
      if (node.run) {
        pushNodeFrame(node);

        let result: ReturnType<NonNullable<Node["run"]>>;

        try {
          result = node.run(ctx);
        } finally {
          // The frame only spans the synchronous run; the async tail is detached.
          popNodeFrame();
        }

        if (isPromiseLike(result)) {
          return parkItem(drain, item, ctx, result, inspected, startedAt);
        } else {
          ctx.value = result;
        }
      }
    } finally {
      runningNodeDepth -= 1;
    }

    finishItem(drain, item, ctx, inspected, startedAt);
  } catch (error) {
    if (inspected) {
      emitInspectorNodeEnd({
        node,
        scope: item.scope,
        payload: item.payload,
        value: ctx.value,
        error,
        failed: true,
        stopped: true,
        meta: item.meta,
        timestamp: inspectorNow(),
        duration: inspectorNow() - startedAt,
      });
    }

    throw error;
  }
}

function parkItem(
  drain: DrainContext,
  item: KernelWorkItem,
  ctx: KernelExecutionContext,
  result: PromiseLike<unknown>,
  inspected: boolean,
  startedAt: number,
): Promise<void> {
  const node = item.node;
  const releaseTask = retainScopeTask(item.scope);
  // Publish this async node's synchronous writes before it parks — but
  // ONLY at the outermost transaction. A reentrant async node (depth > 1)
  // shares its ancestor's still-open transaction; committing here would
  // prematurely flush the ancestor's pending writes and leak an
  // intermediate store value to observers. Nested writes commit atomically
  // at the ancestor's own boundary instead.
  if (activeTransactionDepth() <= 1) commitActiveTransaction();

  const previousPage = currentPage;
  const previousScope = getActiveScope();

  currentPage = rootPage;
  setActiveScope(null);

  let asyncFailure: { error: unknown } | null = null;

  return Promise.resolve(result)
    .then(
      (value) => {
        ctx.value = value;
        ctx.error = undefined;
        ctx.failed = false;
      },
      (error) => {
        ctx.value = undefined;
        ctx.error = error;
        ctx.failed = true;
        // Ordinary async semantics: the statements after an uncaught
        // throw do not run, so nothing downstream of this node runs
        // either — it must not continue on the `undefined` left behind.
        ctx.stopped = true;
        asyncFailure = { error };
      },
    )
    .then(() => {
      const ambientPage = currentPage;
      const ambientScope = setActiveScope(previousScope);
      currentPage = previousPage;
      try {
        finishItem(drain, item, ctx, inspected, startedAt);
        if (asyncFailure) {
          const { error } = asyncFailure;

          // Same rule as a synchronous failure, and the same rule an
          // `async function` follows: the rejection reaches whoever awaits
          // the call. The caller's own node rejects their promise; a
          // propagated one is reported and fails the update as a whole.
          if (!item.propagated) throw error;

          reportContainedError(error, { kind: "async reaction", item });
          (drain.errors ??= []).push(error);
        }
      } finally {
        currentPage = ambientPage;
        setActiveScope(ambientScope);
      }
    })
    .finally(releaseTask);
}

function finishItem(
  drain: DrainContext,
  item: KernelWorkItem,
  ctx: KernelExecutionContext,
  inspected: boolean,
  startedAt: number,
): void {
  const node = item.node;

  if (shouldStopAfterInspectorNode(node)) {
    ctx.stop();
    emitInspectorBreakpointHit({
      node,
      scope: item.scope,
      payload: item.payload,
      value: ctx.value,
      meta: item.meta,
      timestamp: inspectorNow(),
    });
  }

  if (inspected) {
    emitInspectorNodeEnd({
      node,
      scope: item.scope,
      payload: item.payload,
      value: ctx.value,
      error: ctx.error,
      failed: ctx.failed,
      stopped: ctx.stopped,
      meta: item.meta,
      timestamp: inspectorNow(),
      duration: inspectorNow() - startedAt,
    });
  }

  if (ctx.stopped) return;

  propagateItem(drain, item, ctx);
}

/**
 * Whether `item`'s targets may run straight from its propagation: with nothing
 * else queued, the kernel would queue them in order and run them next, each as
 * a propagated item of its own. Only plain targets qualify (no scope of their
 * own, no gate, no priority, no batch), and only when nothing observes the
 * source in its scope besides them.
 */
function runsDirectly(item: KernelWorkItem, next: readonly Node[]): boolean {
  if (item.batchKey !== undefined || isInspectorEnabled()) return false;
  for (let index = 0; index < next.length; index++) {
    const target = next[index];
    if (
      target.run !== directRun ||
      target.resolveScope !== undefined ||
      target.enabled !== undefined ||
      target.next !== undefined ||
      nodePriority(target) !== 0
    )
      return false;
  }
  return item.scope === null || !hasScopedObservers(item.scope, item.node);
}

/**
 * Runs `item`'s targets as the drain would run their queued items, without
 * the items. What only an item can carry is handed back to the queue: a failed
 * target is reported as its item; an asynchronous one parks as its item with
 * the remaining targets queued behind it; a target whose propagation reaches
 * anything queues the remaining targets and then what it reaches.
 */
function runTargetsDirectly(
  drain: DrainContext,
  item: KernelWorkItem,
  next: readonly Node[],
): Promise<void> | void {
  const count = next.length;
  // Queued first, they would all run even if one changed the list.
  const targets = count === 1 ? next : next.slice();
  const scope = item.scope,
    value = item.value,
    page = item.page;
  for (let index = 0; index < count; index++) {
    const target = targets[index];
    // As processItem runs a target's item, and the drain contains its failure.
    currentPage = page;
    setActiveScope(scope);
    let result: unknown;
    // Whether the targets after this one were queued (it parked).
    let queued = false;
    try {
      runningNodeDepth += 1;
      try {
        pushNodeFrame(target);
        try {
          result = runDirect!(target, scope, value);
        } finally {
          popNodeFrame();
        }
        if (isPromiseLike(result)) {
          const parked = targetItem(item, target);
          parked.drain = drain;
          for (let rest = index + 1; rest < count; rest++)
            push(drain, targetItem(item, targets[rest]));
          queued = true;
          const resumed = parkItem(drain, parked, parked, result, false, 0);
          parkedTarget = parked;
          return resumed;
        }
      } finally {
        runningNodeDepth -= 1;
      }
    } catch (error) {
      // A propagated item's failure stops its own branch only.
      reportContainedError(error, { kind: "reaction", item: targetItem(item, target) });
      (drain.errors ??= []).push(error);
      if (queued) return;
      continue;
    }
    // What its item's propagation would reach is queued behind the remaining
    // targets, which then run from the queue too.
    if (target.next?.length || (scope !== null && hasScopedObservers(scope, target))) {
      for (let rest = index + 1; rest < count; rest++) push(drain, targetItem(item, targets[rest]));
      const ran = targetItem(item, target);
      ran.value = result;
      propagateItem(drain, ran, ran);
      return;
    }
  }
}

/** The item `target` would have had in `item`'s propagation. */
function targetItem(item: KernelWorkItem, target: Node): WorkItem {
  return new WorkItem(
    target,
    item.page,
    item.scope,
    item.value,
    item.value,
    item.meta,
    item.batchKey,
    true,
    item,
  );
}

function propagateItem(
  drain: DrainContext,
  item: KernelWorkItem,
  ctx: Pick<KernelExecutionContext, "scope" | "value" | "meta">,
): void {
  const node = item.node;

  // Static structural edges: scope-independent topology (`.map`, explicit
  // reactions, effect sub-units, …).
  const next = node.next;
  if (next)
    for (let index = 0; index < next.length; index++) {
      const target = next[index];
      if (!coalesceIntoSlot(drain, target, item, ctx))
        push(
          drain,
          new WorkItem(
            target,
            item.page,
            ctx.scope,
            ctx.value,
            ctx.value,
            ctx.meta,
            item.batchKey,
            true,
            item,
          ),
        );
    }

  // Dynamic per-scope edges: auto-tracked dependents (computed invalidators,
  // auto-reactions) that read this node in `ctx.scope`. Looked up only for the
  // firing scope, so a data-dependent dependency in another scope is untouched.
  const scope = ctx.scope;
  if (scope) {
    const work = scopedWork,
      previousDrain = work.drain,
      previousItem = work.item,
      previousContext = work.ctx;
    work.drain = drain;
    work.item = item;
    work.ctx = ctx;
    try {
      visitScopedObservers(scope, node, work);
    } finally {
      work.drain = previousDrain;
      work.item = previousItem;
      work.ctx = previousContext;
    }
  }
}

/** Queues the scoped observers of the item being propagated, without a closure per item. */
class ScopedWork implements ScopedObserverVisitor {
  drain: DrainContext | undefined = undefined;
  item: KernelWorkItem | undefined = undefined;
  ctx: Pick<KernelExecutionContext, "scope" | "value" | "meta"> | undefined = undefined;
  visitScopedObserver(observer: Node): boolean {
    const drain = this.drain!,
      item = this.item!,
      ctx = this.ctx!;
    if (!coalesceIntoSlot(drain, observer, item, ctx))
      push(
        drain,
        new WorkItem(
          observer,
          item.page,
          ctx.scope,
          ctx.value,
          ctx.value,
          ctx.meta,
          item.batchKey,
          true,
          item,
        ),
      );
    return true;
  }
}
const scopedWork = new ScopedWork();

function claimSlot(node: SlottedNode, item: WorkItem, drain: DrainContext): boolean {
  try {
    node[queuedSlot] = item;
  } catch {
    // A frozen node keeps using the drain's batch map.
    return false;
  }
  item.slotOf = drain;
  return true;
}

function releaseSlot(item: WorkItem): void {
  item.slotOf = undefined;
  const node = item.node as SlottedNode;
  if (node[queuedSlot] === item) node[queuedSlot] = undefined;
}

/** A failed drain drops its queue; its items must not keep their nodes' slots. */
function releaseQueuedSlots(drain: DrainContext): void {
  const queue = drain.queue;
  for (let index = drain.head; index < queue.length; index++) {
    const item = queue[index] as WorkItem;
    if (item.slotOf === drain) releaseSlot(item);
  }
}

/**
 * A fan-in target is reached once per source: when it already waits in this
 * drain for the same scope and key, refresh that item instead of allocating one
 * that `push` would merge anyway.
 */
function coalesceIntoSlot(
  drain: DrainContext,
  target: Node,
  item: KernelWorkItem,
  ctx: Pick<KernelExecutionContext, "scope" | "value" | "meta">,
): boolean {
  if (item.batchKey === undefined) return false;
  const slot = (target as SlottedNode)[queuedSlot];
  if (slot === undefined || slot.slotOf !== drain || slot.batchKey !== item.batchKey) return false;
  const scope = ctx.scope && target.resolveScope ? target.resolveScope(ctx.scope) : ctx.scope;
  if (slot.scope !== scope) return false;
  const enabled = target.enabled;
  if (typeof enabled === "function" ? !enabled() : enabled === false) return false;
  slot.payload = ctx.value;
  slot.value = ctx.value;
  slot.error = undefined;
  slot.failed = false;
  slot.meta = ctx.meta;
  return true;
}

function waitForDrain(drain: DrainContext): Promise<void> {
  return new Promise((resolve, reject) => {
    (drain.waiters ??= []).push({ resolve, reject });
  });
}

function settleFlushWaiters(drain: DrainContext, failed: boolean, error: unknown): void {
  if (!drain.waiters?.length) return;
  const waiters = drain.waiters.splice(0);

  for (const waiter of waiters) {
    if (failed) {
      waiter.reject(error);
    } else {
      waiter.resolve();
    }
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") && value !== null && "then" in value
  );
}
