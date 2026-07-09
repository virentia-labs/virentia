import { node } from "../../lib/internal";
import type { Node } from "../../lib/internal";
import type { Scope } from "../../lib";
import { getScopedObservers } from "../../lib/kernel/scoped-edges";

// Shared graph/reaction test helpers. `flush` drains the microtask queue via a
// single macrotask turn (deterministic: every queued microtask completes before
// a `setTimeout(0)` callback). `makeGates` hands out one-shot promises the tests
// release explicitly, so async ordering is never left to chance.
export const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

export function makeGates() {
  const releases: Array<() => void> = [];

  return {
    wait: (): Promise<void> => new Promise<void>((resolve) => releases.push(resolve)),
    release: (index: number): void => releases[index]?.(),
    releaseAll: (): void => releases.forEach((release) => release()),
    get count(): number {
      return releases.length;
    },
  };
}

export const nextOf = (source: Node): readonly Node[] => source.next ?? [];
export const observersOf = (sc: Scope, source: Node): Node[] => [
  ...(getScopedObservers(sc, source) ?? []),
];
export const mkNode = (id: string): Node => node({ id });
