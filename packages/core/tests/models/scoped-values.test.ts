import { computed, effect, event, reaction, scope, scoped, store } from "../../lib";
import { scopedModelValue, withUnitDeclarationTracker } from "../../lib/internal";
import { children, f, model, staticModel } from "../../lib/models";
import { expect, it } from "vitest";

it("binds nested namespace stores, effects, getters and lifecycle properties per instance", async () => {
  const Row = staticModel({ setup() {
    const count = store(0);
    const fill = effect<number, void>(value => { count.value = value; });
    return { api: scopedModelValue({ nested: { count, fill }, get doubled() { return count.value * 2; } }) };
  } });
  const app = scope(), [a, b] = scoped(app, () => Row.create([{}, {}]));
  try {
    expect(a.api).toBe(a.api);
    expect(a.api.nested.count.node).toBe(b.api.nested.count.node);
    await a.api.nested.fill(7);
    expect([a.api.nested.count.value, b.api.nested.count.value]).toEqual([7, 0]);
    expect(a.api.doubled).toBe(14);
    expect(Object.keys(a.api.nested)).toEqual(["count", "fill"]);
    await a.dispose();
    expect(() => a.api.nested.count.value).toThrow(/disposed/);
  } finally { await a.dispose(); await b.dispose(); }
});

it("initializes namespace data after owned children without declaring units", () => {
  const Child = staticModel({ data: { value: f.string("ready") } });
  const seen: string[] = [];
  const Parent = staticModel({
    data: { child: children.one(Child) },
    setup(self) {
      return { api: scopedModelValue({ current: computed(() => self.child.value?.value.value) }, {
        initialize(value) { seen.push(value.current.value!); },
      }) };
    },
    onCreate(self) { if (!self.child.value) self.child.create({}); },
  });
  const counts: string[] = [];
  const parent = withUnitDeclarationTracker(kind => counts.push(kind), () => scoped(scope(), () => Parent.create({})));
  expect(counts).toEqual([]);
  expect(seen).toEqual(["ready"]);
  parent.dispose();
});

it("binds a callable namespace's native unit properties", async () => {
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const Row = staticModel({ setup() {
    return { load: scopedModelValue(effect(async () => { await gate; return 1; })) };
  } });
  const [a, b] = scoped(scope(), () => Row.create([{}, {}]));
  const pending = a.load();
  try {
    expect(a.load.pending.value).toBe(true);
    expect(b.load.pending.value).toBe(false);
    finish(); await pending;
    expect(a.load.pending.value).toBe(false);
  } finally { finish(); await pending; await a.dispose(); await b.dispose(); }
});

it("binds a plain effect member's pending and lifecycle units lazily", async () => {
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const Row = staticModel({ setup() {
    return { load: effect(async (value: number) => { await gate; return value; }) };
  } });
  const [a, b] = scoped(scope(), () => Row.create([{}, {}]));
  const seen: number[] = [];
  const watcher = reaction({ on: a.load.doneData, run: value => { seen.push(value); } });
  const pending = a.load(2);
  try {
    expect(a.load.pending.value).toBe(true);
    expect(b.load.pending.value).toBe(false);
    finish(); await pending; await b.load(3);
    expect(seen).toEqual([2]);
    expect(a.load.pending.value).toBe(false);
  } finally { finish(); await pending; watcher.stop(); await a.dispose(); await b.dispose(); }
});

it("preserves a namespaced effect abort implementation and cancels only its own scope", async () => {
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const signals: AbortSignal[] = [];
  const Row = staticModel({ setup() {
    return { load: scopedModelValue(effect(async (_value: void, { signal }) => {
      signals.push(signal); await gate;
    })) };
  } });
  const [a, b] = scoped(scope(), () => Row.create([{}, {}]));
  const reasons: unknown[] = [];
  const watcher = reaction({ on: a.load.abort.map(reason => reason), run: reason => { reasons.push(reason); } });
  const pa = a.load(), pb = b.load();
  const outcome = Promise.allSettled([pa, pb]);
  try {
    await a.load.abort("stop a");
    expect(signals.map(signal => signal.aborted)).toEqual([true, false]);
    finish();
    expect((await outcome).map(value => value.status)).toEqual(["rejected", "fulfilled"]);
    await b.load.abort("later b");
    expect(reasons).toEqual(["stop a"]);
  } finally { finish(); await outcome; watcher.stop(); await a.dispose(); await b.dispose(); }
});

it("releases derived bound-event edges and guards a saved handle after disposal", async () => {
  const Row = staticModel({ setup() { return { changed: event<number>() }; } });
  const a = scoped(scope(), () => Row.create({}));
  const changed = a.changed, initial = changed.node.next?.length ?? 0;
  const mapped = changed.map(value => value * 2);
  expect(changed.node.next?.length).toBe(initial + 1);
  await a.dispose();
  expect(changed.node.next?.length ?? 0).toBe(initial);
  expect(() => changed.map(value => value)).toThrow(/disposed/);
  expect(() => mapped.filter(() => true)).toThrow(/disposed/);
});

it("supports per-instance namespaces in dynamic models too", async () => {
  const Row = model({ setup() {
    const count = store(0);
    return { api: scopedModelValue({ count }, { initialize(api) { api.count.value = 3; } }) };
  } });
  const row = scoped(scope(), () => Row.create({}));
  try { expect(row.api.count.value).toBe(3); } finally { await row.dispose(); }
});

it("observes a model computed only in subscribed instance scopes", async () => {
  const runs: number[] = [], seen: number[] = [];
  const Row = staticModel({ data: { count: f.number(1) }, setup(self) {
    return { doubled: computed(() => { runs.push(self.count.value); return self.count.value * 2; }) };
  } });
  const [a, b] = scoped(scope(), () => Row.create([{}, {}]));
  const stop = a.doubled.subscribe(value => seen.push(value));
  try {
    expect(runs).toEqual([1]);
    b.count.value = 2;
    expect(runs).toEqual([1]);
    a.count.value = 3;
    expect(seen).toEqual([6]);
    stop();
    a.count.value = 4;
    expect(runs).toEqual([1, 3]);
    expect(a.doubled.value).toBe(8);
    expect(b.doubled.value).toBe(4);
  } finally { stop(); await a.dispose(); await b.dispose(); }
});

it("recovers scoped computed subscriptions after an initially failing read", async () => {
  const seen: number[] = [];
  const Row = staticModel({ data: { count: f.number(0) }, setup(self) {
    return { value: computed(() => { const count = self.count.value; if (!count) throw Error("Not ready"); return count; }) };
  } });
  const row = scoped(scope(), () => Row.create({}));
  const stop = row.value.subscribe(value => seen.push(value));
  try {
    row.count.value = 1;
    expect(seen).toEqual([1]);
  } finally { stop(); await row.dispose(); }
});

it("infers a bound store reaction's instance scope and rejects mixed instance sources", async () => {
  const Row = staticModel({ data: { count: f.number(0) }, setup(self) {
    return { value: computed(() => self.count.value * 2) };
  } });
  const [a, b] = scoped(scope(), () => Row.create([{}, {}]));
  const seen: number[] = [];
  const watcher = reaction({ on: a.value, run: value => { seen.push(value); } });
  try {
    b.count.value = 1;
    expect(seen).toEqual([]);
    a.count.value = 2;
    expect(seen).toEqual([4]);
    expect(() => reaction({ on: [a.value, b.value], run() {} })).toThrow(/different scopes/);
  } finally { watcher.stop(); await a.dispose(); await b.dispose(); }
});

it("recovers a bound computed reaction after an initially failing read", async () => {
  const Row = staticModel({ data: { count: f.number(0) }, setup(self) {
    return { value: computed(() => { const value = self.count.value; if (!value) throw Error("Not ready"); return value; }) };
  } });
  const row = scoped(scope(), () => Row.create({})), seen: number[] = [];
  const watcher = reaction({ on: row.value, run: value => { seen.push(value); } });
  try { row.count.value = 1; expect(seen).toEqual([1]); }
  finally { watcher.stop(); await row.dispose(); }
});

it("does not inspect the subscribe getter of ordinary native reaction sources", () => {
  const value = store(0), seen: number[] = [];
  Object.defineProperty(value, "subscribe", { get() { throw Error("subscribe must stay lazy"); } });
  const watcher = reaction({ on: value, run: next => { seen.push(next); } });
  try { scoped(scope(), () => { value.value = 1; }); expect(seen).toEqual([1]); }
  finally { watcher.stop(); }
});

it("rejects a late reaction on disposed native and computed handles before scope reuse", async () => {
  const Row = staticModel({ data: { count: f.number(0) }, setup(self) {
    return { native: store(0), value: computed(() => self.count.value * 2) };
  } });
  const app = scope(), row = scoped(app, () => Row.create({ id: "same" }));
  const count = row.native, value = row.value;
  await row.dispose();
  expect(() => reaction({ on: count, run() {} })).toThrow(/disposed/);
  expect(() => reaction({ on: value, run() {} })).toThrow(/disposed/);
  const fresh = scoped(app, () => Row.create({ id: "same" }));
  try { fresh.count.value = 2; expect(fresh.value.value).toBe(4); }
  finally { await fresh.dispose(); }
});

it("recovers a subscribed map whose computed parent initially fails", async () => {
  const seen: number[] = [];
  const Row = staticModel({ data: { count: f.number(0) }, setup(self) {
    const input = computed(() => { const count = self.count.value; if (!count) throw Error("Not ready"); return count; });
    return { value: input.map(count => count * 2) };
  } });
  const row = scoped(scope(), () => Row.create({}));
  const stop = row.value.subscribe(value => seen.push(value));
  try { row.count.value = 2; expect(seen).toEqual([4]); }
  finally { stop(); await row.dispose(); }
});

it("detaches computed subscriptions on disposal and keeps late unsubscribe harmless after reuse", async () => {
  const app = scope(), old: number[] = [], seen: number[] = [];
  const Row = staticModel({ data: { count: f.number(1) }, setup(self) {
    return { doubled: computed(() => self.count.value * 2) };
  } });
  const first = scoped(app, () => Row.create({ id: "same" }));
  const stopOld = first.doubled.subscribe(value => old.push(value));
  await first.dispose();
  const fresh = scoped(app, () => Row.create({ id: "same" }));
  const stop = fresh.doubled.subscribe(value => seen.push(value));
  try {
    stopOld();
    fresh.count.value = 2;
    expect(old).toEqual([]);
    expect(seen).toEqual([4]);
  } finally { stop(); stopOld(); await fresh.dispose(); }
});
