import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { event, reaction, scope, scoped, store, type Store } from "@virentia/core";

// Supplemental regression workload: original competitor scenarios stay intact.
const width = 8,
  depth = 3,
  warmup = 200,
  updates = 2000;
const app = scope(),
  tick = event();
const sources = Array.from({ length: width }, () => store(0));
let computations = 0;
const terminals = sources.map((source) => {
  let current: Store<number> = source;
  for (let level = 0; level < depth; level++) {
    const delta = level + 1;
    current = current.map((value) => {
      computations++;
      return value + delta;
    });
  }
  return current;
});
reaction({
  on: tick,
  run() {
    for (const source of sources) source.value++;
  },
});
const read = () => scoped(app, () => terminals.reduce((sum, terminal) => sum + terminal.value, 0));
for (let index = 0; index < warmup; index++) {
  await scoped(app, () => tick());
  read();
}
if (!global.gc) throw Error("Use --expose-gc");
for (let index = 0; index < 5; index++) global.gc();
computations = 0;
let checksum = 0;
const started = performance.now();
for (let index = 0; index < updates; index++) {
  await scoped(app, () => tick());
  checksum += read();
}
const elapsedMs = performance.now() - started;
const delta = (depth * (depth + 1)) / 2;
assert.equal(checksum, width * (updates * (warmup + delta) + (updates * (updates + 1)) / 2));
assert.equal(read(), width * (warmup + updates + delta));
assert.equal(computations, width * depth * updates);
assert.equal(
  scoped(scope(), () => terminals.reduce((sum, terminal) => sum + terminal.value, 0)),
  width * delta,
);
console.log(
  JSON.stringify({
    width,
    depth,
    warmup,
    updates,
    elapsedMs,
    checksum,
    computations: width * depth * updates,
    checked: true,
  }),
);
