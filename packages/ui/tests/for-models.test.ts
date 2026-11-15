import { f, refs, staticModel } from "@virentia/core/models";
import { describe, expect, vi } from "vitest";
import { it } from "./support/vitest";
import { component, For, h, type Readable } from "../lib";
import { getInspectorSnapshot } from "../../core/lib/kernel/inspector";

describe("For reads native model containers", () => {
  it("does not allocate redundant row units for ready model instances", async ({ root }) => {
    const Model = staticModel({});
    root.run(() => {
      for (let id = 0; id < 100; id++) Model.create({ id: String(id) });
    });
    const view = vi.fn((_props, self) => h("i", null, self.id));
    const Row = component({ model: Model, view });
    const before = new Set(getInspectorSnapshot().nodes.map((node) => node.id));
    await root.render(() => h(For, { each: Model, view: Row }));
    const nodes = getInspectorSnapshot().nodes.filter((node) => !before.has(node.id));
    expect(nodes.length).toBeLessThan(5);
    const existing = [...root.container.querySelectorAll("i")];
    expect(existing).toHaveLength(100);
    expect(view).toHaveBeenCalledTimes(100);
    const extra = root.run(() => Model.create({ id: "extra" }));
    await extra.dispose();
    expect([...root.container.querySelectorAll("i")]).toEqual(existing);
    expect(view).toHaveBeenCalledTimes(101);
  });

  for (const source of ["definition", "instances"] as const) {
    it(`uses ${source} operations without keys or repeated row views`, async ({ root }) => {
      const Task = staticModel({ data: { title: f.string() } });
      const views = vi.fn((_props, self) => h("p", null, self.model.title));
      const Row = component({ model: Task, view: views });
      const tasks = root.run(() => Task.instances);
      const a = root.run(() => Task.create({ id: "a", title: "A" }));
      await root.render(() => h(For, { each: source === "definition" ? Task : tasks, view: Row }));
      const first = root.container.querySelector("p");
      root.run(() => Task.create({ id: "b", title: "B" }));
      a.title.value = "Alpha";
      expect(root.container.querySelector("p")).toBe(first);
      expect(root.container.textContent).toBe("AlphaB");
      expect(views).toHaveBeenCalledTimes(2);
      await a.dispose();
      expect(root.container.textContent).toBe("B");
    });
  }
  it("translates unresolved reference positions and follows late target arrival and deletion", async ({
    root,
  }) => {
    const Task = staticModel({ data: { title: f.string() } });
    const Selection = staticModel({ data: { tasks: refs.many(Task, { policy: "orphan" }) } });
    const b = root.run(() => Task.create({ id: "b", title: "B" }));
    const selection = root.run(() => Selection.create({ tasks: ["missing", "b"] }));
    const Row = component({ model: Task, view: (_props, self) => h("p", null, self.model.title) });
    await root.render(() => h(For, { each: selection.tasks, view: Row }));
    const existing = root.container.querySelector("p");
    const a = root.run(() => Task.create({ id: "missing", title: "A" }));
    expect(root.container.textContent).toBe("AB");
    expect(root.container.querySelectorAll("p")[1]).toBe(existing);
    selection.tasks.remove("missing");
    expect(root.container.textContent).toBe("B");
    selection.tasks.add(a);
    expect(root.container.textContent).toBe("BA");
    await a.dispose();
    expect(root.container.textContent).toBe("B");
    expect(selection.tasks.ids).toEqual(["b", "missing"]);
    expect(root.container.querySelector("p")).toBe(existing);
    expect(b.alive).toBe(true);
  });
  it("permits repeated immutable values because no row-key matching is performed", async ({
    root,
  }) => {
    await root.render(() =>
      h(For, { each: ["same", "same"], view: (value: Readable<string>) => h("i", null, value) }),
    );
    expect(root.container.querySelectorAll("i")).toHaveLength(2);
    expect(root.container.textContent).toBe("samesame");
  });
});
