import type { KernelContextManager, KernelExecutionContext, RunOptions } from "./types";
import type { Node } from "./types";
import type { CreatePageOptions, KernelWorkItem, Page } from "./internal";
import { getActiveScope, setActiveScope } from "../scope/internal";
import { unwrapMicroScope } from "../scope/micro";
import {
  emitInspectorBreakpointHit,
  emitInspectorNodeEnd,
  emitInspectorNodeStart,
  inspectorNow,
  isInspectorEnabled,
  registerInspectorScope,
  shouldStopAfterInspectorNode,
} from "./inspector";
import { commitActiveTransaction, enterTransaction, exitTransaction } from "./transaction";
import { getScopedObservers } from "./scoped-edges";
import { popNodeFrame, pushNodeFrame } from "./call-stack";

const scopeIds = new WeakMap<object, number>();

let nextPageId = 0;
let nextImplicitNodeId = 0;
let nextScopeId = 0;
let activeDrain: DrainContext | null = null;
let runningNodeDepth = 0;

interface FlushWaiter {
  resolve(): void;
  reject(error: unknown): void;
}

interface DrainContext {
  queue: KernelWorkItem[];
  batchedItems: Map<string, KernelWorkItem>;
  waiters: FlushWaiter[];
  pending: Promise<void>[];
  queueHead: number;
}

export const rootPage = createPage();
export let currentPage: Page = rootPage;

export function createPage(options?: CreatePageOptions): Page {
  const page: Page = {
    id: ++nextPageId,
    parent: options?.parent ?? null,
    contextMap: new Map(),
  };

  if (options?.contexts) {
    for (const context of options.contexts) {
      page.contextMap.set(context.id, context.value);
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
    if (cursor.contextMap.has(id)) {
      return cursor.contextMap.get(id) as T;
    }

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
  page.contextMap.set(id, value);
}

function createDrainContext(): DrainContext {
  return {
    queue: [],
    batchedItems: new Map(),
    waiters: [],
    pending: [],
    queueHead: 0,
  };
}

function push(context: DrainContext, item: KernelWorkItem): void {
  const enabled = item.node.enabled;

  if (typeof enabled === "function" ? !enabled() : enabled === false) {
    return;
  }

  if (item.batchKey !== undefined) {
    const nodeId = item.node.id ?? (item.node.id = ++nextImplicitNodeId);
    item.queueKey = `${getScopeId(item.scope)}:${String(nodeId)}:${String(item.batchKey)}`;
    const queued = context.batchedItems.get(item.queueKey);

    if (queued) {
      queued.payload = item.payload;
      queued.value = item.value;
      queued.error = item.error;
      queued.failed = item.failed;
      queued.meta = item.meta;
      return;
    }

    context.batchedItems.set(item.queueKey, item);
  }

  context.queue.push(item);
}

function getScopeId(scope: object | null): number {
  if (!scope) return 0;

  let id = scopeIds.get(scope);

  if (!id) {
    id = ++nextScopeId;
    scopeIds.set(scope, id);
  }

  return id;
}

function stopContext(this: KernelExecutionContext): void {
  this.stopped = true;
}

function failContext(this: KernelExecutionContext, error: unknown = this.value): void {
  this.error = error;
  this.failed = true;
  this.stopped = true;
}

export async function run(options: RunOptions): Promise<void> {
  const page = createPage({
    parent: currentPage,
    contexts: options.contexts,
  });
  const units = Array.isArray(options.unit) ? options.unit : [options.unit];
  // Units always run in a real scope. A micro-scope is only a tracking overlay
  // for a reaction body, so effects/propagation resolve to its real parent —
  // reads inside an effect then never leak into the reaction's dependencies.
  const scope = unwrapMicroScope(options.scope ?? getActiveScope());

  registerInspectorScope(scope);

  const drain = activeDrain && runningNodeDepth === 0 ? activeDrain : createDrainContext();

  for (const node of units) {
    push(drain, {
      node,
      page,
      scope,
      payload: options.payload,
      value: options.payload,
      error: undefined,
      failed: false,
      batchKey: options.batchKey,
      meta: options.meta ?? {},
    });
  }

  if (activeDrain && runningNodeDepth === 0) {
    return waitForDrain(activeDrain);
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
        parentDrain.pending.push(result);
      }

      return result;
    } finally {
      currentPage = previousPage;
      setActiveScope(previousScope);
    }
  }

  const previousPage = currentPage;
  const previousScope = getActiveScope();
  const result = drainQueue(drain);

  // Restore the caller's synchronous frame as soon as the synchronous portion of
  // the drain yields.
  currentPage = previousPage;
  setActiveScope(previousScope);

  if (isPromiseLike(result)) {
    try {
      await result;
    } finally {
      // The async tail runs detached across microtasks, so no synchronous frame
      // owns the ambient scope here; leaving `previousScope` installed would leak
      // it into whatever ran meanwhile (e.g. a `void run()` from a `scoped()`
      // block). Reset to neutral — the ambient scope after an `await` was never
      // supported, pass it explicitly there.
      currentPage = rootPage;
      setActiveScope(null);
    }
  }
}

function drainQueue(drain: DrainContext): Promise<void> | void {
  const previousDrain = activeDrain;

  activeDrain = drain;

  return continueDrain(drain, previousDrain);
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
    // dropped and `allSettled` would resolve before it completes.
    while (drain.queueHead < drain.queue.length || drain.pending.length > 0) {
      if (drain.queueHead < drain.queue.length) {
        enterTransaction();

        while (drain.queueHead < drain.queue.length) {
          const item = drain.queue[drain.queueHead++];

          if (item.queueKey) drain.batchedItems.delete(item.queueKey);

          const result = processItem(drain, item);

          if (isPromiseLike(result)) {
            exitTransaction();
            activeDrain = previousDrain;

            return result.then(
              () => {
                // On asynchronous resume the synchronous caller that owned
                // `previousDrain` is long gone. Restore whatever drain is active
                // now (usually none) instead of re-installing a parked parent:
                // otherwise a unit call in a later handler continuation would see
                // that parked drain, join it via `waitForDrain`, and deadlock —
                // the drain only settles once the handler finishes, and the
                // handler is blocked on the very call that joined it.
                const resumed = activeDrain;
                activeDrain = drain;
                return continueDrain(drain, resumed);
              },
              (error) => {
                activeDrain = previousDrain;
                settleFlushWaiters(drain, true, error);
                throw error;
              },
            );
          }
        }

        drain.queueHead = 0;
        drain.queue.length = 0;
        exitTransaction();
      }

      if (drain.pending.length > 0) {
        const pending = drain.pending.splice(0);

        activeDrain = previousDrain;

        return Promise.all(pending).then(
          () => {
            // See the note above: restore the drain active at resume time, not
            // the parked `previousDrain` captured when this drain started.
            const resumed = activeDrain;
            activeDrain = drain;
            return continueDrain(drain, resumed);
          },
          (error) => {
            activeDrain = previousDrain;
            settleFlushWaiters(drain, true, error);
            throw error;
          },
        );
      }
    }
  } catch (error) {
    exitTransaction();
    activeDrain = previousDrain;
    settleFlushWaiters(drain, true, error);
    throw error;
  }

  activeDrain = previousDrain;
  settleFlushWaiters(drain, false, undefined);
}

function processItem(drain: DrainContext, item: KernelWorkItem): Promise<void> | void {
  const node = item.node;
  const itemPage = item.page;
  let ctx: KernelExecutionContext;
  const launchFromContext = (unit: Node | readonly Node[], value = ctx.value): void => {
    const nextNodes = Array.isArray(unit) ? unit : [unit];

    for (const nextNode of nextNodes) {
      push(drain, {
        node: nextNode,
        page: itemPage,
        scope: ctx.scope,
        payload: value,
        value,
        error: undefined,
        failed: false,
        meta: ctx.meta,
        batchKey: item.batchKey,
      });
    }
  };

  ctx = {
    node,
    scope: item.scope,
    payload: item.payload,
    value: item.value,
    error: item.error,
    failed: item.failed,
    stopped: false,
    meta: item.meta,
    stop: stopContext,
    fail: failContext,
    launch: launchFromContext,
    getContext<T>(context: KernelContextManager<T>): T {
      return readPageContext(itemPage, context);
    },
    setContext<T>(context: KernelContextManager<T>, value: T): void {
      writePageContext(itemPage, context, value);
    },
  };

  currentPage = item.page;
  setActiveScope(item.scope);

  const inspected = isInspectorEnabled();
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
          commitActiveTransaction();

          const previousPage = currentPage;
          const previousScope = getActiveScope();

          currentPage = rootPage;
          setActiveScope(null);

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
              },
            )
            .then(() => {
              currentPage = previousPage;
              setActiveScope(previousScope);
              finishItem(drain, item, ctx, inspected, startedAt);
            });
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

  // Static structural edges: scope-independent topology (`.map`, explicit
  // reactions, effect sub-units, …).
  for (const next of node.next ?? []) {
    push(drain, {
      node: next,
      page: item.page,
      scope: ctx.scope,
      payload: ctx.value,
      value: ctx.value,
      error: undefined,
      failed: false,
      meta: ctx.meta,
      batchKey: item.batchKey,
    });
  }

  // Dynamic per-scope edges: auto-tracked dependents (computed invalidators,
  // auto-reactions) that read this node in `ctx.scope`. Looked up only for the
  // firing scope, so a data-dependent dependency in another scope is untouched.
  const scopedObservers = ctx.scope ? getScopedObservers(ctx.scope, node) : undefined;

  if (scopedObservers) {
    for (const next of scopedObservers) {
      push(drain, {
        node: next,
        page: item.page,
        scope: ctx.scope,
        payload: ctx.value,
        value: ctx.value,
        error: undefined,
        failed: false,
        meta: ctx.meta,
        batchKey: item.batchKey,
      });
    }
  }
}

function waitForDrain(drain: DrainContext): Promise<void> {
  return new Promise((resolve, reject) => {
    drain.waiters.push({ resolve, reject });
  });
}

function settleFlushWaiters(drain: DrainContext, failed: boolean, error: unknown): void {
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
