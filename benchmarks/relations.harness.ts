import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { scope, scoped } from "@virentia/core";
import { children, f, staticModel } from "@virentia/core/models";
import { sequenceBindingOf } from "@virentia/core/internal";

// Supplemental data-upsert workload, not DOM reconciliation or a replacement
// for the renderer/competitor benchmark. Validate identity outside the timer.
const n = Number(process.argv[2] ?? 25000);
const mode = process.argv[3] ?? "upsert";
assert(Number.isSafeInteger(n) && n > 0 && n <= 25000);
assert(mode === "upsert" || mode === "feed");
const Item = staticModel({ data: { count: f.number(0) } });
const Parent = staticModel({ data: { items: children.many(Item) } });
const app = scope();
const parent = scoped(app, () =>
  Parent.create({
    id: "parent",
    items: Array.from({ length: n }, (_, i) => ({ id: String(i) })),
  }),
);
const original = parent.items.items;
if (mode === "feed") {
  const source = sequenceBindingOf(parent.items)!;
  let edits = 0;
  const stop = source.subscribe((operations) => {
    edits += operations.length;
  });
  const fields = original.map((item) => item.count);
  if (!global.gc) throw Error("Use --expose-gc");
  global.gc();
  const start = performance.now();
  scoped(app, () => {
    for (let i = 0; i < n; i += 10) fields[i].value = 1;
  });
  const elapsedMs = performance.now() - start;
  stop();
  assert.equal(edits, 0);
  assert.deepEqual(source.snapshot(), original);
  for (let i = 0; i < n; i++) assert.equal(fields[i].value, i % 10 ? 0 : 1);
  console.log(JSON.stringify({ n, mode, elapsedMs, writes: Math.ceil(n / 10), checked: true }));
} else {
  const replacement = Array.from({ length: n }, (_, i) => ({ id: String(n - i - 1), count: 1 }));
  if (!global.gc) throw Error("Use --expose-gc");
  global.gc();
  const start = performance.now();
  scoped(app, () => Parent.create({ id: "parent", items: replacement }));
  const upsertMs = performance.now() - start;
  const actual = parent.items.items;
  assert.equal(actual.length, n);
  for (let i = 0; i < n; i++) {
    assert.equal(actual[i], original[n - i - 1]);
    assert.equal(actual[i].count.value, 1);
  }
  assert.equal(scoped(app, () => Item.instances.count), n);
  console.log(JSON.stringify({ n, mode, elapsedMs: upsertMs, upsertMs, checked: true }));
}
