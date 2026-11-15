import type { Scope } from "./scope/types";

/** Internal protocol: data sources describe edits, renderers apply them directly. */
export const sequenceBinding = Symbol.for("virentia.sequence.binding");

export type SequenceOperation<T> =
  | { type: "insert"; index: number; items: readonly T[] }
  | { type: "remove"; index: number; count: number }
  | { type: "move"; from: number; to: number; count: number }
  | { type: "reorder"; order: readonly number[] }
  | { type: "replace"; index: number; item: T }
  | { type: "update"; index: number; item: T }
  | { type: "reset"; items: readonly T[] };

export interface SequenceBinding<T = unknown> {
  readonly scope: Scope;
  snapshot(): readonly T[];
  subscribe(listener: (operations: readonly SequenceOperation<T>[]) => void): () => void;
}

export function sequenceBindingOf<T = unknown>(source: unknown): SequenceBinding<T> | undefined {
  if ((typeof source !== "object" || source === null) && typeof source !== "function") return;
  return (source as { [sequenceBinding]?: SequenceBinding<T> })[sequenceBinding];
}
