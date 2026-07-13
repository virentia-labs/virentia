import type { Scope } from "../scope";

export interface Node {
  id?: PropertyKey;
  run?: KernelNodeFn;
  next?: Node[];
  enabled?: boolean | (() => boolean);
  meta?: Record<string, unknown>;
  // Called when a scope-less (global) observer attaches to this node. A lazy
  // computed uses it to eagerly discover its dependencies and make its edges
  // global, so a global subscription fires in every scope the dependency changes
  // in — not only in scopes where the computed was already evaluated.
  onObserve?: () => void;
}

export interface KernelContext<T = unknown> {
  id: symbol;
  value: T;
}

export interface KernelContextManager<T> {
  id: symbol;

  setup(value: T): KernelContext<T>;
  has(): boolean;
  set(value: T): void;
  get(): T;
  get(fallback: T): T;
  delete(): void;
}

export interface KernelExecutionContext {
  node: Node;
  scope: Scope | null;
  payload: unknown;
  value: unknown;
  error: unknown;
  failed: boolean;
  stopped: boolean;
  meta: Record<string, unknown>;

  stop(): void;
  fail(error?: unknown): void;
  launch(unit: Node | readonly Node[], value?: unknown): void;
  getContext<T>(context: KernelContextManager<T>): T;
  setContext<T>(context: KernelContextManager<T>, value: T): void;
}

export type KernelNodeFn = (ctx: KernelExecutionContext) => PromiseLike<unknown> | unknown;

export interface RunOptions {
  unit: Node | readonly Node[];
  payload?: unknown;
  scope?: Scope | null;
  contexts?: Iterable<KernelContext>;
  batchKey?: PropertyKey;
  meta?: Record<string, unknown>;
}
