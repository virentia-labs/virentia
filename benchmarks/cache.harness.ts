import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { computed, event, reaction, scope, scoped } from "@virentia/core";
import { f, staticModel } from "@virentia/core/models";
import { action, computed as mobxComputed, makeObservable, observable } from "mobx";

const variant = process.argv[2];
const n = 10000;
let computations = 0;
const collect = () => {
  for (let i = 0; i < 5; i++) global.gc!();
};
if (!global.gc) throw Error("Use --expose-gc");
if (!["virentia", "mobx", "mobx-cached"].includes(variant)) throw Error("Unknown variant");

class MobxRow {
  title = "row";
  active = false;
  constructor(public count: number) {
    makeObservable(this, {
      count: observable,
      title: observable,
      active: observable,
      increment: action,
      doubled: variant === "mobx-cached" ? mobxComputed({ keepAlive: true }) : mobxComputed,
    });
  }
  increment() {
    this.count++;
  }
  get doubled() {
    computations++;
    return this.count * 2;
  }
}

const Row = staticModel({
  name: "CachedBenchRow",
  data: { count: f.number(0), title: f.string("row"), active: f.boolean(false) },
  setup(self) {
    const increment = event();
    const doubled = computed(() => {
      computations++;
      return self.count.value * 2;
    });
    reaction({
      on: increment,
      run() {
        self.count.value++;
      },
    });
    return { increment, doubled };
  },
});
const app = scope();
const rows: any[] = [];
// Supplemental workload only: equal computed-read warmup for all cache policies.
// The original creation/dispatch benchmark and its warmup remain unchanged.
for (let i = 0; i < 200; i++) {
  if (variant === "virentia") {
    const row = scoped(app, () => Row.create({ id: `warm-${i}`, count: i }));
    assert.equal(row.doubled.value, i * 2);
    row.dispose();
  } else assert.equal(new MobxRow(i).doubled, i * 2);
}
await new Promise<void>((resolve) => setImmediate(resolve));
collect();
computations = 0;
const baseline = process.memoryUsage().heapUsed;
const creationStarted = performance.now();
if (variant === "virentia")
  scoped(app, () => {
    for (let i = 0; i < n; i++) rows.push(Row.create({ id: String(i), count: i }));
  });
else for (let i = 0; i < n; i++) rows.push(new MobxRow(i));
const createMs = performance.now() - creationStarted;
collect();
const createdHeapBytes = process.memoryUsage().heapUsed - baseline;
const read =
  variant === "virentia"
    ? () => scoped(app, () => rows.reduce((sum, row) => sum + row.doubled.value, 0))
    : () => rows.reduce((sum, row) => sum + row.doubled, 0);
const firstStarted = performance.now();
const checksum = read();
const firstReadMs = performance.now() - firstStarted;
assert.equal(checksum, n * (n - 1));
const firstComputations = computations;
collect();
const activatedHeapBytes = process.memoryUsage().heapUsed - baseline;
const repeatStarted = performance.now();
assert.equal(read(), checksum);
const cachedReadMs = performance.now() - repeatStarted;
const repeatedComputations = computations - firstComputations;
assert.equal(firstComputations, n);
assert.equal(repeatedComputations, variant === "mobx" ? n : 0);
console.log(
  JSON.stringify({
    variant,
    n,
    createMs,
    createdHeapBytes,
    firstReadMs,
    activatedHeapBytes,
    cachedReadMs,
    firstComputations,
    repeatedComputations,
    checksum,
  }),
);
