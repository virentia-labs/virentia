import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";

if (!global.gc) throw Error("Use --expose-gc");
const build = process.argv[2] ?? "current";
if (!/^[a-z0-9-]+$/i.test(build)) throw Error("Invalid build");
const { scope, scoped, f, staticModel } = await import(
  new URL(`.build/library-${build}-minified.mjs`, import.meta.url)
);
const Row = staticModel({ data: { count: f.number(0).indexed() } });
const Singleton = Row.static();
function abandon(i) {
  const app = scope();
  const row = scoped(app, () => Row.create({ id: "same", count: i }));
  row.count.value = i + 1;
  scoped(app, () => {
    Singleton.count.value = i;
  });
  return [new WeakRef(app), new WeakRef(row)];
}
const refs = Array.from({ length: 100 }, (_, i) => abandon(i)).flat();
await setImmediate();
let remaining = refs.length;
for (let attempt = 0; attempt < 40 && remaining; attempt++) {
  global.gc();
  await setImmediate();
  remaining = refs.filter((ref) => ref.deref() !== undefined).length;
  await setImmediate();
}
assert.equal(remaining, 0, "Shared field subscriptions retain abandoned applications");
const live = scope();
const row = scoped(live, () => Row.create({ id: "live" }));
row.count.value = 7;
assert.equal(
  scoped(live, () => Row.where(Row.count.eq(7)).first),
  row,
);
scoped(live, () => {
  Singleton.count.value = 9;
});
assert.equal(
  scoped(live, () => Singleton.count.value),
  9,
);
console.log(
  JSON.stringify({
    build,
    abandonedScopes: 100,
    weakTargets: refs.length,
    remaining,
    liveRouting: true,
    manualDisposal: false,
  }),
);
