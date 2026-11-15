import { expect, it } from "vitest";
import { computed, scope, scoped } from "../../lib";
import { f, model, staticModel } from "../../lib/models";
import { collection, stateOfCollection } from "../../lib/models/collection";
import { collectModelFieldReads, instanceInternalOf } from "../../lib/models/definition";
import { sequenceBindingOf, type SequenceOperation } from "../../lib/sequence";

it.each([staticModel, model])(
  "keeps sparse equality indexes in insertion order and releases obsolete buckets (%s)",
  async (declare) => {
    const Row = declare({ data: { rank: f.number().indexed() } });
    const app = scope();
    const rows = scoped(app, () =>
      Row.create(Array.from({ length: 50 }, (_, i) => ({ id: String(i), rank: i }))),
    );
    const source = scoped(app, () => collection(Row));
    const state = stateOfCollection(source);
    const index = state.indexes.get("rank")!;
    // Each row keeps its own key per eq index.
    const keyOf = (row: object) => instanceInternalOf(row)!.indexKeys?.[0];
    const keyed = () => [...state.rows.values()].filter((row) => row.indexKeys).length;
    rows[0].rank.value = 47;
    rows[20].rank.value = 47;
    rows[0].rebind("renamed");
    expect(source.where(Row.rank.eq(47)).toArray()).toEqual([rows[0], rows[20], rows[47]]);
    expect(index.has(0)).toBe(false);
    expect(index.has(20)).toBe(false);
    expect([...index.values()].some((bucket) => bucket.has("0"))).toBe(false);
    expect(keyOf(rows[0])).toBe(47);
    await rows[0].dispose();
    await rows[20].dispose();
    await rows[47].dispose();
    expect(source.where(Row.rank.eq(47)).count).toBe(0);
    expect(index.has(47)).toBe(false);
    expect(keyed()).toBe(47);
    expect(keyOf(rows[20])).toBeUndefined();
    const fresh = scoped(app, () => Row.create({ id: "fresh", rank: 47 }));
    expect(source.where(Row.rank.eq(47)).first).toBe(fresh);
    expect(index.get(47)).toEqual(new Set(["fresh"]));
  },
);

it("uses value-normalized Date keys when moving and rebinding an indexed row", async () => {
  const Row = staticModel({ data: { at: f.date().indexed() } });
  const app = scope();
  const row = scoped(app, () => Row.create({ id: "row", at: new Date(1000).toISOString() }));
  const source = scoped(app, () => collection(Row));
  const index = stateOfCollection(source).indexes.get("at")!;
  row.at.value = new Date(1000);
  expect(source.where(Row.at.eq(new Date(1000))).first).toBe(row);
  row.at.value = new Date(2000);
  row.rebind("new-id");
  expect(source.where(Row.at.eq(new Date(1000))).count).toBe(0);
  expect(source.where(Row.at.eq(new Date(2000))).first).toBe(row);
  expect(index.size).toBe(1);
  await row.dispose();
  expect(index.size).toBe(0);
});

it("reads each sort key once and finds a changed row's new rank logarithmically", () => {
  const Row = staticModel({ data: { rank: f.number() } });
  const app = scope();
  const rows = scoped(app, () =>
    Row.create(
      Array.from({ length: 1024 }, (_, i) => ({
        id: String(i),
        rank: (i * 401) % 1024,
      })),
    ),
  );
  const query = scoped(app, () => Row.sort(Row.rank.asc));
  let reads = 0;
  const sorted = collectModelFieldReads(
    () => reads++,
    () => query.toArray(),
  );
  expect(reads).toBe(1024);
  expect(sorted.map((row) => row.rank.value)).toEqual(Array.from({ length: 1024 }, (_, i) => i));
  const feed = sequenceBindingOf(query)!;
  const operations: SequenceOperation<unknown>[] = [];
  const stop = feed.subscribe((edits) => operations.push(...edits));
  reads = 0;
  collectModelFieldReads(
    () => reads++,
    () => {
      rows[0].rank.value = 2048;
    },
  );
  expect(reads).toBe(1);
  expect(operations).toEqual([{ type: "move", from: 0, to: 1023, count: 1 }]);
  stop();
});

it("keeps a filtered top window correct across ties, rebind, removal and scope reuse", async () => {
  const Row = staticModel({ data: { rank: f.number(), visible: f.boolean(true) } });
  const app = scope();
  const rows = scoped(app, () =>
    Row.create(
      Array.from({ length: 64 }, (_, i) => ({
        id: String(i),
        rank: i % 7,
      })),
    ),
  );
  const query = scoped(app, () => Row.where(Row.visible.eq(true)).sort(Row.rank.asc).take(7));
  const feed = sequenceBindingOf(query)!;
  const visible = [...feed.snapshot()];
  const stop = feed.subscribe((edits) => {
    for (const edit of edits) {
      if (edit.type === "insert") visible.splice(edit.index, 0, ...edit.items);
      else if (edit.type === "remove") visible.splice(edit.index, edit.count);
      else if (edit.type === "move")
        visible.splice(edit.to, 0, ...visible.splice(edit.from, edit.count));
      else throw new Error(`Unexpected ${edit.type}`);
    }
  });
  for (let i = 0; i < 60; i++) {
    const row = rows[(i * 17) % rows.length];
    if (i % 3 === 0) row.visible.value = !row.visible.value;
    else row.rank.value = (i * 11) % 9;
    if (i % 7 === 0) row.rebind(`renamed-${i}`);
    expect(visible).toEqual(feed.snapshot());
  }
  await rows[0].dispose();
  await Promise.resolve();
  const fresh = scoped(app, () => Row.create({ id: "fresh", rank: 0 }));
  expect(visible).toEqual(feed.snapshot());
  fresh.rank.value = -1;
  expect(visible).toEqual(feed.snapshot());
  expect(visible[0]).toBe(fresh);
  stop();
});

it("reports a bulk removal as one edit per run of adjacent removed rows", () => {
  const Row = staticModel({ data: { rank: f.number(), keep: f.boolean(false) } });
  const app = scope();
  scoped(app, () =>
    Row.create(Array.from({ length: 10 }, (_, i) => ({ id: String(i), rank: i, keep: i % 4 === 3 }))),
  );
  const all = scoped(app, () => Row.sort(Row.rank.asc));
  const feed = sequenceBindingOf(all)!;
  const visible = [...feed.snapshot()];
  const batches: SequenceOperation<unknown>[][] = [];
  const stop = feed.subscribe((edits) => {
    batches.push([...edits]);
    for (const edit of edits) if (edit.type === "remove") visible.splice(edit.index, edit.count);
  });
  scoped(app, () => Row.where(Row.keep.eq(false)).remove());
  expect(batches).toEqual([
    [
      { type: "remove", index: 0, count: 3 },
      { type: "remove", index: 1, count: 3 },
      { type: "remove", index: 2, count: 2 },
    ],
  ]);
  expect(visible).toEqual(feed.snapshot());
  expect(visible.map((row) => (row as { id: string }).id)).toEqual(["3", "7"]);
  batches.length = 0;
  scoped(app, () => Row.instances.remove());
  expect(batches).toEqual([[{ type: "remove", index: 0, count: 2 }]]);
  expect(feed.snapshot()).toEqual([]);
  stop();
});

// A bulk removal is one update: an observer of the collection's version sees the
// final state once, not one intermediate count per removed row.
it("notifies an observer of a count once per bulk removal", () => {
  const Row = staticModel({ data: { done: f.boolean(false).indexed() } });
  const app = scope();
  scoped(app, () =>
    Row.create(Array.from({ length: 20 }, (_, i) => ({ id: String(i), done: i % 2 === 0 }))),
  );
  const done = computed(() => Row.where(Row.done.eq(true)).count);
  const all = computed(() => Row.instances.count);
  expect(scoped(app, () => [done.value, all.value])).toEqual([10, 20]);
  const seen: [string, number][] = [];
  done.subscribe((value) => seen.push(["done", value]));
  all.subscribe((value) => seen.push(["all", value]));

  scoped(app, () => Row.where(Row.done.eq(false)).remove());
  expect(seen).toEqual([["all", 10]]);
  seen.length = 0;

  scoped(app, () => Row.instances.remove());
  expect(seen).toEqual([
    ["done", 0],
    ["all", 0],
  ]);
  expect(scoped(app, () => [done.value, all.value])).toEqual([0, 0]);
});
