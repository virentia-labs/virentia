import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";
import type { Store } from "../../lib";

// The scope a computed discovers its dependencies in when first observed lives
// until the end of a synchronous burst. Graphs built, observed and dropped in
// one burst must still be collectable within it: its states must not keep them.
// Development builds hold every unit through a weak reference for devtools,
// which keeps it alive until the job ends: load the library as in production.
setFlagsFromString("--expose-gc");
const collect = runInNewContext("gc") as () => void;
const previousEnv = process.env.NODE_ENV;
process.env.NODE_ENV = "production";
const { computed, scope, scoped, store } = await import("../../lib");
process.env.NODE_ENV = previousEnv;

function buildObserveDrop(layers: number): void {
  const app = scope();
  const start = [store(1), store(2), store(3), store(4)];
  let layer: Store<number>[] = start;
  const all: Store<number>[] = [];
  for (let index = 0; index < layers; index++) {
    const [a, b, c, d] = layer;
    const next = [
      b.map((value) => value),
      computed(() => a.value - c.value),
      computed(() => b.value + d.value),
      c.map((value) => value),
    ];
    all.push(...next);
    layer = next;
  }
  const offs = all.map((node) => {
    scoped(app, () => node.value);
    return node.subscribe(() => {});
  });
  for (const off of offs) off();
}

it("collects graphs observed and dropped in one synchronous burst", () => {
  const heap = (): number => {
    collect();
    collect();
    return process.memoryUsage().heapUsed;
  };
  buildObserveDrop(500);
  const first = heap();
  for (let round = 0; round < 6; round++) buildObserveDrop(500);
  const grown = heap() - first;
  // A retained graph of this size is about 2.5 MB; values alone stay well below.
  expect(grown).toBeLessThan(6 * 1024 * 1024);
});
