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

const queue: KernelWorkItem[] = [];
const batchedItems = new Map<string, KernelWorkItem>();
const scopeIds = new WeakMap<object, number>();
const flushWaiters: FlushWaiter[] = [];

let nextPageId = 0;
let nextImplicitNodeId = 0;
let nextScopeId = 0;
let queueHead = 0;
let flushing = false;

interface FlushWaiter {
  resolve(): void;
  reject(error: unknown): void;
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

function push(item: KernelWorkItem): void {
  const enabled = item.node.enabled;

  if (typeof enabled === "function" ? !enabled() : enabled === false) {
    return;
  }

  if (item.batchKey !== undefined) {
    const nodeId = item.node.id ?? (item.node.id = ++nextImplicitNodeId);
    item.queueKey = `${getScopeId(item.scope)}:${String(nodeId)}:${String(item.batchKey)}`;
    const queued = batchedItems.get(item.queueKey);

    if (queued) {
      queued.payload = item.payload;
      queued.value = item.value;
      queued.error = item.error;
      queued.failed = item.failed;
      queued.meta = item.meta;
      return;
    }

    batchedItems.set(item.queueKey, item);
  }

  queue.push(item);
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

  for (const node of units) {
    push({
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

  if (flushing) {
    return waitForFlush();
  }

  flushing = true;

  const previousPage = currentPage;
  const previousScope = getActiveScope();
  let flushError: unknown;
  let hasFlushError = false;

  try {
    while (queueHead < queue.length) {
      const item = queue[queueHead++];

      if (item.queueKey) batchedItems.delete(item.queueKey);

      if (queueHead === queue.length) {
        queueHead = 0;
        queue.length = 0;
      }

      const node = item.node;
      const itemPage = item.page;
      let ctx: KernelExecutionContext;
      const launchFromContext = (unit: Node | readonly Node[], value = ctx.value): void => {
        const nextNodes = Array.isArray(unit) ? unit : [unit];

        for (const nextNode of nextNodes) {
          push({
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
        if (node.run) {
          const result = node.run(ctx);

          if (isPromiseLike(result)) {
            currentPage = previousPage;
            setActiveScope(previousScope);

            try {
              ctx.value = await result;
              ctx.error = undefined;
              ctx.failed = false;
            } catch (error) {
              ctx.value = undefined;
              ctx.error = error;
              ctx.failed = true;
            } finally {
              currentPage = item.page;
              setActiveScope(item.scope);
            }
          } else {
            ctx.value = result;
          }
        }

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

      if (ctx.stopped) continue;

      for (const next of node.next ?? []) {
        push({
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
  } catch (error) {
    flushError = error;
    hasFlushError = true;
    throw error;
  } finally {
    currentPage = previousPage;
    setActiveScope(previousScope);
    flushing = false;
    settleFlushWaiters(hasFlushError, flushError);
  }
}

function waitForFlush(): Promise<void> {
  return new Promise((resolve, reject) => {
    flushWaiters.push({ resolve, reject });
  });
}

function settleFlushWaiters(failed: boolean, error: unknown): void {
  const waiters = flushWaiters.splice(0);

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
