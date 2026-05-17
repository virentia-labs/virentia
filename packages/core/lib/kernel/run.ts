import type { KernelContextManager, KernelExecutionContext, RunOptions } from "./types";
import type { Node } from "./types";
import type { CreatePageOptions, KernelWorkItem, Page } from "./internal";
import { getActiveScope, setActiveScope } from "../scope/internal";
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
  const scope = options.scope ?? getActiveScope();

  registerInspectorScope(scope);

  const drain =
    activeDrain && runningNodeDepth === 0
      ? activeDrain
      : createDrainContext();

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
    const result = drainQueue(drain);

    if (isPromiseLike(result)) {
      parentDrain.pending.push(result);
    }

    return result;
  }

  const previousPage = currentPage;
  const previousScope = getActiveScope();

  try {
    const result = drainQueue(drain);

    if (isPromiseLike(result)) {
      await result;
    }
  } catch (error) {
    throw error;
  } finally {
    currentPage = previousPage;
    setActiveScope(previousScope);
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
    while (drain.queueHead < drain.queue.length) {
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
              activeDrain = drain;
              return continueDrain(drain, previousDrain);
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

      if (drain.pending.length > 0) {
        const pending = drain.pending.splice(0);

        activeDrain = previousDrain;

        return Promise.all(pending).then(
          () => {
            activeDrain = drain;
            return continueDrain(drain, previousDrain);
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
        const result = node.run(ctx);

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
