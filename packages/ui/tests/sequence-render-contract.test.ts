import { computed } from "@virentia/core";
import { children, f, staticModel } from "@virentia/core/models";
import { mutableStore } from "@virentia/mutable";
import { describe, expect, vi } from "vitest";
import { it } from "./support/vitest";
import { component, createElement as h, For, type Readable } from "../lib";

describe("operation-driven lists", () => {
  it("updates child fields in place without rerunning relation row views", async ({ root }) => {
    const Item = staticModel({ data: { count: f.number(0) } });
    const Board = staticModel({ data: { items: children.many(Item) } });
    const view = vi.fn((_props, self) => h("p", null, self.model.count));
    const Row = component({ model: Item, view });
    const board = root.run(() => Board.create({
      items: Array.from({ length: 1000 }, (_, i) => ({ id: String(i) })),
    }));
    const items = board.items.items;
    await root.render(() => h(For, { each: board.items, view: Row }));
    const initial = [...root.container.querySelectorAll("p")];
    root.run(() => {
      for (let i = 0; i < items.length; i += 10) items[i].count.value = 1;
    });
    expect([...root.container.querySelectorAll("p")]).toEqual(initial);
    expect(initial.map(row => row.textContent)).toEqual(items.map((_, i) => i % 10 ? "0" : "1"));
    expect(view).toHaveBeenCalledTimes(1000);
  });

  it("keeps value-row indices reactive through insertion, removal and reordering", async ({
    root,
  }) => {
    const items = mutableStore(["a", "b", "c"]);
    const view = vi.fn((item: Readable<string>, index: Readable<number>) =>
      h("p", { "data-index": index }, item),
    );
    await root.render(() => h(For, { each: items, view }));
    const initial = [...root.container.querySelectorAll("p")];
    root.run(() => items.value.reverse());
    expect([...root.container.querySelectorAll("p")]).toEqual(initial.slice().reverse());
    const indices = () =>
      [...root.container.querySelectorAll("p")].map((row) => row.getAttribute("data-index"));
    expect(indices()).toEqual(["0", "1", "2"]);
    root.run(() => items.value.unshift("d"));
    expect(indices()).toEqual(["0", "1", "2", "3"]);
    expect(root.container.querySelectorAll("p")[1]).toBe(initial[2]);
    root.run(() => items.value.splice(1, 1));
    expect(indices()).toEqual(["0", "1", "2"]);
    expect(root.container.querySelectorAll("p")[1]).toBe(initial[1]);
    expect(view).toHaveBeenCalledTimes(4);
  });

  it("moves model children without rebuilding rows or requiring keys", async ({ root }) => {
    const Task = staticModel({ data: { title: f.string() } });
    const Board = staticModel({ data: { tasks: children.many(Task) } });
    const views = vi.fn();
    const Row = component({
      model: Task,
      view(_props, self) {
        views();
        return h("p", null, self.model.title);
      },
    });
    const board = root.run(() =>
      Board.create({
        tasks: [
          { id: "a", title: "A" },
          { id: "b", title: "B" },
        ],
      }),
    );
    await root.render(() => h(For, { each: board.tasks, view: Row }));
    const [first, second] = root.container.querySelectorAll("p");
    root.run(() => board.tasks.move("b", 0));
    expect([...root.container.querySelectorAll("p")]).toEqual([second, first]);
    expect(views).toHaveBeenCalledTimes(2);
    const third = root.run(() => board.tasks.add({ id: "c", title: "C" }));
    expect(root.container.textContent).toBe("BAC");
    expect(views).toHaveBeenCalledTimes(3);
    await root.run(() => board.tasks.remove("b"));
    expect(root.container.textContent).toBe("AC");
    root.run(() => {
      third.title.value = "Changed";
    });
    expect(root.container.querySelector("p")).toBe(first);
    expect(root.container.textContent).toBe("AChanged");
    expect(views).toHaveBeenCalledTimes(3);
  });

  it("updates where/sort/take from affected model operations", async ({ root }) => {
    const Task = staticModel({
      data: { title: f.string(), rank: f.number(), visible: f.boolean(true) },
    });
    const Row = component({ model: Task, view: (_props, self) => h("p", null, self.model.title) });
    const [a, b, c] = root.run(() =>
      Task.create([
        { id: "a", title: "A", rank: 1 },
        { id: "b", title: "B", rank: 2 },
        { id: "c", title: "C", rank: 3 },
      ]),
    );
    const query = root.run(() => Task.where(Task.visible.eq(true)).sort(Task.rank.asc).take(2));
    await root.render(() => h(For, { each: query, view: Row }));
    const first = root.container.querySelector("p");
    root.run(() => {
      c.rank.value = 0;
    });
    expect(root.container.textContent).toBe("CA");
    expect(root.container.querySelectorAll("p")[1]).toBe(first);
    root.run(() => {
      c.visible.value = false;
    });
    expect(root.container.textContent).toBe("AB");
    expect(root.container.querySelector("p")).toBe(first);
    root.run(() => {
      b.title.value = "Beta";
    });
    expect(root.container.textContent).toBe("ABeta");
  });

  it("uses mutable-array mutations, including nested data changes, without a list diff", async ({
    root,
  }) => {
    const Model = staticModel({
      setup() {
        return { items: mutableStore([{ title: "B" }, { title: "A" }]) };
      },
    });
    const RowModel = staticModel({ data: { title: f.string() } });
    const view = vi.fn((_props, self) => h("p", null, self.model.title));
    const Row = component({ model: RowModel, view });
    const instance = root.run(() => Model.create({}));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await root.render(() => h(For, { each: instance.items, view: Row }));
      const [b, a] = root.container.querySelectorAll("p");
      root.run(() => instance.items.value.sort((a, b) => a.title.localeCompare(b.title)));
      expect([...root.container.querySelectorAll("p")]).toEqual([a, b]);
      root.run(() => {
        instance.items.value[0].title = "Alpha";
      });
      expect(root.container.querySelector("p")).toBe(a);
      expect(a.textContent).toBe("Alpha");
      root.run(() => instance.items.value.push({ title: "C" }));
      expect(root.container.textContent).toBe("AlphaBC");
      root.run(() => instance.items.value.splice(1, 1));
      expect(root.container.textContent).toBe("AlphaC");
      expect(root.container.querySelector("p")).toBe(a);
      expect(view).toHaveBeenCalledTimes(3);
      expect(warn).not.toHaveBeenCalled();
      root.run(() => {
        instance.items.value = [{ title: "Reset" }];
      });
      expect(root.container.textContent).toBe("Reset");
      expect(root.container.querySelector("p")).not.toBe(a);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("warns for a computed array and recreates it rather than matching IDs", async ({ root }) => {
    const Model = staticModel({
      data: { count: f.number(1) },
      setup(self) {
        return {
          items: computed(() =>
            Array.from({ length: self.count.value }, (_, index) => String(index)),
          ),
        };
      },
    });
    const instance = root.run(() => Model.create({}));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await root.render(() =>
        h(For, { each: instance.items, view: (item: any) => h("p", null, item) }),
      );
      const first = root.container.querySelector("p");
      root.run(() => {
        instance.count.value = 2;
      });
      expect(root.container.textContent).toBe("01");
      expect(root.container.querySelector("p")).not.toBe(first);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
