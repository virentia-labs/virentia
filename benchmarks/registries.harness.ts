import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { scope, scoped } from "@virentia/core";
import { f, staticModel } from "@virentia/core/models";

// One shared definition rendered/tested in independent application scopes.
// This supplements, and does not alter, the original competitor workloads.
const scopes = Number(process.argv[2]);
assert([1, 100, 1000].includes(scopes));
const Row = staticModel({ data: { count: f.number(0).indexed() } });
const apps = Array.from({ length: scopes }, () => scope());
const rows = apps.map((app) => scoped(app, () => Row.create({ id: "same" })));
const fields = rows.map((row) => row.count);
const writes = 10000,
  warmup = 200;
for (let i = 1; i <= warmup; i++) fields[0].value = i;
if (!global.gc) throw Error("Use --expose-gc");
for (let i = 0; i < 5; i++) global.gc();
const started = performance.now();
for (let i = 1; i <= writes; i++) fields[0].value = warmup + i;
const writeMs = performance.now() - started;
for (let i = 0; i < apps.length; i++) {
  const expected = i === 0 ? warmup + writes : 0;
  assert.equal(fields[i].value, expected);
  assert.equal(
    scoped(apps[i], () => Row.where(Row.count.eq(expected)).first),
    rows[i],
  );
  assert.equal(
    scoped(apps[i], () => Row.instances.count),
    1,
  );
}
console.log(JSON.stringify({ scopes, writes, warmup, writeMs, checked: true }));
