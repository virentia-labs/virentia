import { describe, expect, it } from "vitest";
import { computed, event, reaction, scope, scoped, serialize } from "../../lib";
import { f, staticModel } from "../../lib/models";
import { instanceInternalOf } from "../../lib/models/definition";
import { captureScopeSnapshot, withTransaction } from "../../lib/internal";

// A static instance without relations starts light: its fields live in a seed
// until something needs its scope. Every path must see the same values before
// and after the scope exists.
const isLight = (row: object): boolean => instanceInternalOf(row)!.fieldSeed !== undefined;

function rowModel(name?: string) {
  return staticModel({
    ...(name ? { name } : {}),
    data: {
      count: f.number(0).indexed("ord"),
      title: f.string("row"),
      done: f.boolean(false).indexed(),
    },
    setup(self) {
      const increment = event<number>();
      const doubled = computed(() => self.count.value * 2);
      reaction({
        on: increment,
        run: (by) => {
          self.count.value += by;
        },
      });
      return { increment, doubled };
    },
  });
}

describe("light static instances", () => {
  it("read their fields from the seed without creating a scope", () => {
    const Row = rowModel();
    const app = scope();
    const [a, b] = scoped(app, () => Row.create([{ id: "a", count: 2 }, { id: "b" }]));
    expect([isLight(a), isLight(b)]).toEqual([true, true]);
    expect([a.count.value, a.title.value, b.count.value, b.done.value]).toEqual([2, "row", 0, false]);
    expect(scoped(app, () => a.count.value)).toBe(2);
    expect(scoped(scope(), () => a.count.value)).toBe(2);
    expect(isLight(a)).toBe(true);
  });

  it("move the seed into the scope on the first write and keep the other fields", () => {
    const Row = rowModel();
    const row = scoped(scope(), () => Row.create({ id: "a", count: 2, title: "first" }));
    row.done.value = true;
    expect(isLight(row)).toBe(false);
    expect([row.count.value, row.title.value, row.done.value]).toEqual([2, "first", true]);
  });

  it("move the seed into the scope for tracked reads, members and reactions", async () => {
    const Row = rowModel();
    const app = scope();
    const row = scoped(app, () => Row.create({ id: "a", count: 3 }));
    const total = computed(() => row.count.value + 1);
    const seen: number[] = [];
    scoped(app, () => reaction({ on: total, run: (value) => seen.push(value) }));
    expect(scoped(app, () => total.value)).toBe(4);
    expect(row.doubled.value).toBe(6);
    await row.increment(2);
    expect([row.count.value, row.doubled.value]).toEqual([5, 10]);
    expect(scoped(app, () => total.value)).toBe(6);
    expect(seen).toEqual([6]);
  });

  it("keep indexes and queries over seeded values", () => {
    const Row = rowModel();
    const app = scope();
    scoped(app, () =>
      Row.create([
        { id: "a", count: 3 },
        { id: "b", count: 1, done: true },
        { id: "c", count: 2 },
      ]),
    );
    scoped(app, () => {
      expect(Row.where(Row.done.eq(false)).sort(Row.count.desc).items.map((row) => row.id)).toEqual(
        ["a", "c"],
      );
      expect(Row.where(Row.count.gte(2)).count).toBe(2);
      expect(Row.instances.items.every(isLight)).toBe(true);
    });
  });

  it("serialize SID fields, register at the first snapshot reader and hydrate", () => {
    const Row = rowModel("LightRow");
    const app = scope();
    const [a, b] = scoped(app, () => Row.create([{ id: "a", count: 4 }, { id: "b" }]));
    expect(isLight(a)).toBe(true);
    const state = serialize(app);
    expect(Object.values(state)).toContain(4);
    // Registration needs the scope: the flush created it.
    expect([isLight(a), isLight(b)]).toEqual([false, false]);
    const client = scope({ snapshot: state });
    const restored = scoped(client, () => Row.create([{ id: "a" }, { id: "b" }]));
    expect(restored.map((row) => row.count.value)).toEqual([4, 0]);
    expect(serialize(client)).toEqual(state);
  });

  it("are created light again after the root has registered instances", () => {
    const Row = rowModel();
    const app = scope();
    scoped(app, () => Row.create({ id: "a", count: 1 }));
    serialize(app);
    const later = scoped(app, () => Row.create({ id: "b", count: 2 }));
    expect(later.count.value).toBe(2);
    expect(serialize(app)).toEqual(serialize(app));
  });

  it("copy into a renderer's read view", () => {
    const Row = rowModel("LightView");
    const app = scope();
    scoped(app, () => Row.create({ id: "a", count: 7 }));
    const view = captureScopeSnapshot(app);
    expect(serialize(view)).toEqual(serialize(app));
  });

  it("merge, rebind, serialize to JSON and dispose while light", async () => {
    const Row = rowModel();
    const app = scope();
    const row = scoped(app, () => Row.create({ id: "a", count: 1 }));
    expect(row.json()).toMatchObject({ id: "a", count: 1, title: "row", done: false });
    scoped(app, () => Row.create({ id: "a", title: "merged" }));
    expect([row.count.value, row.title.value]).toEqual([1, "merged"]);
    const other = scoped(app, () => Row.create({ id: "b", count: 5 }));
    other.rebind("c");
    expect(scoped(app, () => Row.get("c"))).toBe(other);
    expect(other.count.value).toBe(5);
    await other.dispose();
    expect(scoped(app, () => Row.get("c"))).toBeNull();
    expect(() => other.count.value).toThrow();
  });

  it("reuse a disposed light instance's slot for a new light instance", async () => {
    const Row = rowModel();
    const app = scope();
    const first = scoped(app, () => Row.create({ id: "a", count: 1 }));
    await first.dispose();
    await Promise.resolve();
    const second = scoped(app, () => Row.create({ id: "a", count: 2 }));
    expect(second).not.toBe(first);
    expect(second.count.value).toBe(2);
    second.count.value = 3;
    expect(second.count.value).toBe(3);
  });

  it("stage a write in a transaction like an instance with a scope", () => {
    const Row = rowModel();
    const app = scope();
    const row = scoped(app, () => Row.create({ id: "a", count: 1 }));
    scoped(app, () =>
      withTransaction(() => {
        row.count.value = 2;
        expect(row.count.value).toBe(2);
      }),
    );
    expect(row.count.value).toBe(2);
  });

  it("are created with a scope while a root restores a snapshot", () => {
    const Row = rowModel("LightRestore");
    const server = scope();
    scoped(server, () => Row.create({ id: "a", count: 9 }));
    const client = scope({ snapshot: serialize(server) });
    const row = scoped(client, () => Row.create({ id: "a" }));
    expect(isLight(row)).toBe(false);
    expect(row.count.value).toBe(9);
  });
});
