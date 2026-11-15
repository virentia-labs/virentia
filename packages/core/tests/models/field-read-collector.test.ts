import { describe, expect, it, vi } from "vitest";
import { computed, reaction, scope, scoped } from "../../lib";
import { collectNodes, modelInstanceBindingOf } from "../../lib/internal";
import { children, collectModelFieldReads, f, model, staticModel } from "../../lib/models";
import { collection } from "../../lib/models/collection";
import type { ModelFieldReadSource } from "../../lib/models";

describe("model field read collector", () => {
  it("adds a cross-instance bridge only when a foreign tracked scope reads the field", () => {
    const Row = staticModel({ data: { count: f.number(0) } });
    const app = scope();
    const [first, second] = scoped(app, () => Row.create([{ id: "first" }, { id: "second" }]));
    const native = Row.fields.get("count")!.staticStore!;
    const subscribe = vi.spyOn(native.node as unknown as { subscribe(...args: unknown[]): unknown }, "subscribe");
    const local = modelInstanceBindingOf(first)!.scope;
    const reads = scoped(local, () => collectNodes(() => first.count.value));
    expect(reads.nodes).toEqual(new Set([native.node]));
    expect(subscribe).not.toHaveBeenCalled();
    expect(first.count.value).toBe(0);
    expect(subscribe).not.toHaveBeenCalled();
    const seen: number[] = [];
    const observer = reaction({
      scope: app,
      run: () => {
        seen.push(first.count.value);
      },
    });
    expect(subscribe).toHaveBeenCalledTimes(1);
    second.count.value = 2;
    expect(seen).toEqual([0]);
    first.count.value = 1;
    expect(seen).toEqual([0, 1]);
    observer.stop();
    subscribe.mockRestore();
  });

  it("collects stable field/member sources and filters instance notifications", () => {
    const Todo = staticModel({
      data: { title: f.string("") },
      setup(self: any) {
        return { upper: computed(() => self.title.value.toUpperCase()) };
      },
    });
    const app = scope();

    scoped(app, () => {
      const todos = collection(Todo);
      const first = todos.add({ id: "first", title: "one" });
      const second = todos.add({ id: "second", title: "two" });
      const sources = new Set<ModelFieldReadSource>();
      const value = collectModelFieldReads(
        (source) => sources.add(source),
        () => `${first.title.value}:${first.upper.value}`,
      );

      expect(value).toBe("one:ONE");
      expect(sources.size).toBe(2);
      const [field] = sources;
      const seen: string[] = [];
      const unsubscribe = field!.subscribe(() => seen.push(first.title.value));

      second.title.value = "changed";
      expect(seen).toEqual([]);
      first.title.value = "updated";
      expect(seen).toEqual(["updated"]);
      unsubscribe();
      first.title.value = "again";
      expect(seen).toEqual(["updated"]);
    });
  });

  it.each([staticModel, model])(
    "collects stable relation sources and routes writes to their owner",
    (kind) => {
      const Task = kind({ data: { title: f.string("") } });
      const Board = kind({ data: { tasks: children.many(Task) } });
      const app = scope();
      scoped(app, () => {
        const first = collection(Board).add({});
        const second = collection(Board).add({});
        const sources = new Set<ModelFieldReadSource>();
        collectModelFieldReads(
          (source) => sources.add(source),
          () => [first.tasks.items, first.tasks.ids, first.tasks.count],
        );
        expect(sources.size).toBe(1);
        const [source] = sources;
        const counts: number[] = [];
        const unsubscribe = source!.subscribe(() => counts.push(first.tasks.count));
        second.tasks.add({ title: "Elsewhere" });
        expect(counts).toEqual([]);
        const task = first.tasks.add({ title: "Owned" });
        first.tasks.remove(task);
        expect(counts).toEqual([1, 0]);
        unsubscribe();
        first.tasks.add({ title: "After unsubscribe" });
        expect(counts).toEqual([1, 0]);
      });
    },
  );
});

describe("static model field subscriptions", () => {
  it("route a write only to the written instance's subscribers", () => {
    const Row = staticModel({ data: { count: f.number(0) } });
    const app = scope();
    const rows = scoped(app, () =>
      Row.create(Array.from({ length: 100 }, (_, i) => ({ id: String(i) }))),
    );
    const native = Row.fields.get("count")!.staticStore!;
    const subscribe = vi.spyOn(native.node as unknown as { subscribe(...args: unknown[]): unknown }, "subscribe");
    const calls: string[] = [];
    const offs = rows.map((row) => row.count.subscribe(() => calls.push(row.id)));
    // One shared route for every instance subscription.
    expect(subscribe).toHaveBeenCalledTimes(1);
    rows[42].count.value = 1;
    expect(calls).toEqual(["42"]);
    for (const off of offs) off();
    rows[42].count.value = 2;
    expect(calls).toEqual(["42"]);
    const again = rows[1].count.subscribe((value) => calls.push(`again:${value}`));
    expect(subscribe).toHaveBeenCalledTimes(2);
    rows[1].count.value = 5;
    expect(calls).toEqual(["42", "again:5"]);
    again();
    subscribe.mockRestore();
  });

  it("does not deliver a recycled scope's writes to a disposed instance's subscribers", async () => {
    const Row = staticModel({ data: { count: f.number(0) } });
    const app = scope();
    const old = scoped(app, () => Row.create({ id: "old" }));
    const calls: string[] = [];
    old.count.subscribe(() => calls.push("old"));
    await old.dispose();
    await Promise.resolve();
    const fresh = scoped(app, () => Row.create({ id: "fresh" }));
    fresh.count.subscribe(() => calls.push("fresh"));
    fresh.count.value = 3;
    expect(calls).toEqual(["fresh"]);
  });
});
