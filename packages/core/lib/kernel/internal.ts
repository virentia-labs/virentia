import type { KernelContext, Node } from "./types";
import type { Scope } from "../scope";

export interface Page {
  id: number;
  parent: Page | null;
  contextMap: Map<symbol, unknown>;
}

export interface KernelWorkItem {
  node: Node;
  page: Page;
  scope: Scope | null;
  payload: unknown;
  value: unknown;
  error: unknown;
  failed: boolean;
  batchKey?: PropertyKey;
  queueKey?: string;
  meta: Record<string, unknown>;
  // True for items the graph enqueued by following an edge, false for the item a
  // `run()` caller initiated. A failure in a propagated item is contained and
  // reported; a failure in the caller's own item still rejects their promise.
  propagated?: boolean;
  // The item whose propagation enqueued this one. Walked backwards only when
  // something fails, so the happy path pays nothing but a field assignment.
  parent?: KernelWorkItem;
}

export interface CreatePageOptions {
  parent?: Page | null;
  contexts?: Iterable<KernelContext>;
}
