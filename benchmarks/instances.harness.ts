import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { event, reaction, scope, scoped } from "@virentia/core";
import { f, model, staticModel } from "@virentia/core/models";
import { modelInstanceBindingOf, type ModelDisposalTrace } from "@virentia/core/internal";

// Supplemental allocation experiment, not a replacement for the original
// modeled-row benchmark. Plain/stateless rows deliberately provide less API.
const variant = process.argv[2];
assert(["plain", "shared-empty", "shared", "dynamic"].includes(variant));
const n = 10000;
if (!global.gc) throw Error("Use --expose-gc");
const gc = () => {
  for (let i = 0; i < 5; i++) global.gc!();
};
let setupCalls = 0;
const define = variant === "dynamic" ? model : staticModel;
const definition =
  variant === "plain"
    ? undefined
    : define({
        data: variant === "shared-empty" ? {} : { count: f.number(0) },
        setup(self: any) {
          setupCalls++;
          if (variant === "shared-empty") return {};
          const increment = event();
          reaction({
            on: increment,
            run() {
              self.count.value++;
            },
          });
          return { increment };
        },
      } as any);
const app = scope();
const registry = new Map<string, object>();
const order: object[] = [];
function create(id: string) {
  const props = { id, dom: { text: "0" } };
  if (definition) return definition.create(props);
  const row = { id, props };
  registry.set(id, row);
  order.push(row);
  return row;
}
const trace: ModelDisposalTrace = {};
function dispose(row: any) {
  if (definition) modelInstanceBindingOf(row)!.disposeWithTrace!(trace);
  else {
    registry.delete(row.id);
    assert.equal(order.pop(), row);
  }
}
scoped(app, () => {
  const warm = Array.from({ length: 200 }, (_, i) => create(`warm-${i}`));
  for (let i = warm.length - 1; i >= 0; i--) dispose(warm[i]);
});
await new Promise<void>((resolve) => setImmediate(resolve));
gc();
const baseline = process.memoryUsage().heapUsed;
let rows: any[] = [];
const start = performance.now();
scoped(app, () => {
  for (let i = 0; i < n; i++) rows.push(create(String(i)));
});
const createMs = performance.now() - start;
gc();
const createdHeapBytes = process.memoryUsage().heapUsed - baseline;
assert.equal(rows.length, n);
if (variant === "shared" || variant === "dynamic") {
  await rows[0].increment();
  assert.equal(rows[0].count.value, 1);
  assert.equal(rows[1].count.value, 0);
  assert.equal(rows[0].increment.node === rows[1].increment.node, variant === "shared");
}
const setupCallsAtCreation = setupCalls;
const stop = performance.now();
scoped(app, () => {
  for (let i = rows.length - 1; i >= 0; i--) dispose(rows[i]);
});
const disposeMs = performance.now() - stop;
if (definition)
  assert.equal(
    scoped(app, () => definition.instances.count),
    0,
  );
rows = [];
await new Promise<void>((resolve) => setImmediate(resolve));
gc();
console.log(
  JSON.stringify({
    variant,
    n,
    createMs,
    createdHeapBytes,
    disposeMs,
    setupCalls: setupCallsAtCreation,
  }),
);
