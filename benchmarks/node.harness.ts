import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { computed, event, reaction, scope, scoped, store } from "@virentia/core";
import { f, staticModel } from "@virentia/core/models";
import { action, computed as mobxComputed, makeObservable, observable } from "mobx";
import { allSettled, createEvent, createStore, fork } from "effector";

const [area, variant, scenario = "1000"] = process.argv.slice(2);
const gc = () => {
  for (let i = 0; i < 5; i++) global.gc!();
};
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
function sumVirentiaDerived(sum: number, row: any): number {
  return sum + row.doubled.value;
}
if (!global.gc) throw Error("Use --expose-gc");

async function models() {
  const n = 10000;
  // Class methods and annotations are shared; no per-instance autorun is added.
  class MobxRow {
    count: number;
    title = "row";
    active = false;
    constructor(count: number) {
      this.count = count;
      makeObservable(this, {
        count: observable,
        title: observable,
        active: observable,
        increment: action,
        doubled: mobxComputed,
      });
    }
    increment() {
      this.count++;
    }
    get doubled() {
      return this.count * 2;
    }
  }
  const Row = staticModel({
    name: "BenchRow",
    data: { count: f.number(0), title: f.string("row"), active: f.boolean(false) },
    setup(self: any) {
      const increment = event();
      const doubled = computed(() => self.count.value * 2);
      reaction({
        on: increment,
        run() {
          self.count.value++;
        },
      });
      return { increment, doubled };
    },
  } as any);
  const app = scope();
  const rows: any[] = [];
  const c = { add: (input: any) => Row.create(input) };
  if (variant === "virentia") {
    scoped(app, () => {
      for (let i = 0; i < 200; i++) {
        const r = c.add({ id: `warm-${i}`, count: i });
        r.dispose();
      }
    });
  } else if (variant === "mobx") {
    for (let i = 0; i < 200; i++) {
      const r = new MobxRow(i);
      r.increment();
      assert.equal(r.doubled, (i + 1) * 2);
    }
  } else throw Error("Unknown model variant");
  await turn();
  gc();
  const baseline = process.memoryUsage().heapUsed;
  const start = performance.now();
  if (variant === "virentia") {
    scoped(app, () => {
      for (let i = 0; i < n; i++) rows.push(c.add({ id: String(i), count: i }));
    });
  } else {
    for (let i = 0; i < n; i++) rows.push(new MobxRow(i));
  }
  const createMs = performance.now() - start;
  gc();
  const createdHeapBytes = process.memoryUsage().heapUsed - baseline;
  const activationStart = performance.now();
  const checksum =
    variant === "virentia"
      ? scoped(app, () => rows.reduce(sumVirentiaDerived, 0))
      : rows.reduce((sum, row) => sum + row.doubled, 0);
  const activationMs = performance.now() - activationStart;
  gc();
  const activatedHeapBytes = process.memoryUsage().heapUsed - baseline;
  assert.equal(checksum, n * (n - 1));
  // Behavior is verified after the measured creation and heap samples.
  if (variant === "virentia") {
    await rows[0].increment();
    assert.equal(rows[0].doubled.value, 2);
    assert.equal(rows[1].count.value, 1);
  } else {
    rows[0].increment();
    assert.equal(rows[0].doubled, 2);
    assert.equal(rows[1].count, 1);
  }
  assert.equal(rows.length, n);
  return {
    n,
    createMs,
    createdHeapBytes,
    activationMs,
    activatedHeapBytes,
    checksum,
    liveRows: rows.length,
  };
}

async function core() {
  const events = 10000,
    width = 10,
    warmup = 1000;
  let dispatch: () => Promise<unknown>;
  let read: () => number[];
  if (variant === "virentia") {
    const tick = event<number>();
    const values = Array.from({ length: width }, () => store(0));
    reaction({
      on: tick,
      run(value) {
        for (const state of values) state.value += value;
      },
    });
    const app = scope();
    dispatch = () => scoped(app, () => tick(1));
    read = () => scoped(app, () => values.map((value) => value.value));
  } else if (variant === "effector") {
    const tick = createEvent<number>();
    const values = Array.from({ length: width }, () =>
      createStore(0).on(tick, (value, delta) => value + delta),
    );
    const app = fork();
    dispatch = () => allSettled(tick, { scope: app, params: 1 });
    read = () => values.map((value) => app.getState(value));
  } else throw Error("Unknown core variant");
  for (let i = 0; i < warmup; i++) await dispatch();
  assert.deepEqual(read(), Array(width).fill(warmup));
  gc();
  const start = performance.now();
  for (let i = 0; i < events; i++) await dispatch();
  const dispatchMs = performance.now() - start;
  assert.deepEqual(read(), Array(width).fill(events + warmup));
  return { events, width, warmup, dispatchMs, checksum: read().reduce((a, b) => a + b, 0) };
}

const result =
  area === "models"
    ? await models()
    : area === "core"
      ? await core()
      : (() => {
          throw Error("Unknown area");
        })();
console.log(JSON.stringify({ area, variant, scenario, ...result }));
