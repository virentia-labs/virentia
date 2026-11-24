import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { computed, event, reaction, scope, scoped } from "@virentia/core";
import { f, staticModel } from "@virentia/core/models";

// Diagnostic only: larger than the unchanged comparison workload to sample its
// first-read path reliably. Timings here are not competitor benchmark results.
const tag = process.argv[2] ?? "current";
const allocations = process.argv.includes("--allocation");
if (!/^[a-z0-9-]+$/i.test(tag)) throw Error("Invalid profile tag");
const n = 100000;
let computations = 0;
const Row = staticModel({
  name: "ProfileRow",
  data: { count: f.number(0), title: f.string("row"), active: f.boolean(false) },
  setup(self) {
    const increment = event();
    reaction({
      on: increment,
      run() {
        self.count.value++;
      },
    });
    return {
      increment,
      doubled: computed(() => {
        computations++;
        return self.count.value * 2;
      }),
    };
  },
});
const app = scope();
const rows: any[] = [];
scoped(app, () => {
  for (let i = 0; i < n; i++) rows.push(Row.create({ id: String(i), count: i }));
});
await new Promise<void>((resolve) => setImmediate(resolve));
for (let i = 0; i < 5; i++) global.gc?.();
function sumDerived(sum: number, row: any) {
  return sum + row.doubled.value;
}
function readRows() {
  return scoped(app, () => rows.reduce(sumDerived, 0));
}
const session = new Session();
session.connect();
await session.post("Profiler.enable");
await session.post("Profiler.setSamplingInterval", { interval: 100 });
for (const phase of ["cold", "cached"] as const) {
  if (allocations) await session.post("HeapProfiler.startSampling", {
    samplingInterval: 2048, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true,
  });
  else await session.post("Profiler.start");
  let checksum = 0;
  for (let i = 0; i < (phase === "cold" ? 1 : 10); i++) checksum = readRows();
  const { profile } = allocations ? await session.post("HeapProfiler.stopSampling") : await session.post("Profiler.stop");
  assert.equal(checksum, n * (n - 1));
  assert.equal(computations, n);
  writeFileSync(
    new URL(`./profile-models-${tag}-${phase}.${allocations ? "heapprofile" : "cpuprofile"}`, import.meta.url),
    JSON.stringify(profile),
  );
}
session.disconnect();
console.log(
  JSON.stringify({
    tag,
    n,
    computations,
    cachedPasses: 10,
    allocations,
    checksum: n * (n - 1),
    node: process.version,
  }),
);
