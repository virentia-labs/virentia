import { expect, it } from "vitest";
import { scope, scoped } from "../../lib";
import { children, f, inverse, model, staticModel } from "../../lib/models";
import { sequenceBindingOf, type SequenceOperation } from "../../lib/sequence";

// Several children added or removed at once reach a relation's subscribers as
// a few operations, with the relation written once, not once per child.

function watch(view: unknown) {
  const feed = sequenceBindingOf<{ id: string }>(view)!;
  const ids = feed.snapshot().map((item) => item.id);
  const operations: string[] = [];
  const stop = feed.subscribe((batch: readonly SequenceOperation<{ id: string }>[]) => {
    for (const operation of batch) {
      operations.push(
        JSON.stringify(operation, (key, value) =>
          key === "items" ? (value as { id: string }[]).map((item) => item.id) : value,
        ),
      );
      if (operation.type === "insert") ids.splice(operation.index, 0, ...operation.items.map((item) => item.id));
      else if (operation.type === "remove") ids.splice(operation.index, operation.count);
    }
  });
  return { ids, operations, stop };
}

it.each([staticModel, model])("adds a batch of children in one operation (%s)", (declare) => {
  const define = declare as typeof staticModel;
  const Item = define({ data: { label: f.string("") } });
  const Parent = define({ data: { items: children.many(Item) } });
  scoped(scope(), () => {
    const parent = Parent.create({ id: "parent", items: [{ id: "a" }] });
    const feed = watch(parent.items);
    const added = parent.items.add([{ id: "b" }, { id: "a", label: "merged" }, { id: "c" }]);
    expect(added.map((item) => item.id)).toEqual(["b", "a", "c"]);
    expect(feed.operations).toEqual(['{"type":"insert","index":1,"items":["b","c"]}']);
    expect(feed.ids).toEqual(["a", "b", "c"]);
    expect(parent.items.ids).toEqual(["a", "b", "c"]);
    expect(Item.get("a")!.label.value).toBe("merged");
    feed.stop();
  });
});

it("adds nothing when one child of a batch is invalid", () => {
  const Item = staticModel({ data: { count: f.number(0) } });
  const Parent = staticModel({ data: { items: children.many(Item) } });
  scoped(scope(), () => {
    const parent = Parent.create({ id: "parent" });
    expect(() => parent.items.add([{ id: "a" }, { id: "b", count: "many" as never }])).toThrow();
    expect(parent.items.ids).toEqual([]);
    expect(Item.instances.count).toBe(0);
  });
});

it.each([staticModel, model])("drops the children of a bulk removal in runs (%s)", (declare) => {
  const define = declare as typeof staticModel;
  const Item = define({
    data: { rank: f.number(0), owner: inverse(() => Parent.items) },
  });
  const Parent = define({ data: { items: children.many(Item) } });
  scoped(scope(), () => {
    const parent = Parent.create({
      id: "parent",
      items: Array.from({ length: 6 }, (_, index) => ({ id: String(index), rank: index % 3 === 0 ? 1 : 0 })),
    });
    const feed = watch(parent.items);
    Item.where(Item.rank.eq(0)).remove();
    expect(feed.operations).toEqual([
      '{"type":"remove","index":1,"count":2}',
      '{"type":"remove","index":2,"count":2}',
    ]);
    expect(parent.items.ids).toEqual(["0", "3"]);
    expect(feed.ids).toEqual(["0", "3"]);
    expect((Item.get("3")!.owner as { value: { id: string } | null }).value?.id).toBe("parent");
    Item.instances.remove();
    expect(parent.items.ids).toEqual([]);
    expect(feed.ids).toEqual([]);
    feed.stop();
  });
});
