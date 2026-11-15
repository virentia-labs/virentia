import { computed, effect, reaction, store } from "@virentia/core";
import { f, staticModel } from "@virentia/core/models";
import { collection } from "../../core/lib/models/collection";
import { describe, expect, vi } from "vitest";
import { it } from "./support/vitest";
import { component, h, ui } from "../lib";

describe("structural fragments, without reconciliation", () => {
  it("uses ordinary if/ternary only in an explicit fragment and leaves other DOM bindings in place", async ({ root }) => {
    const Model = staticModel({ data: { count: f.number(1), visible: f.boolean(true) },
      setup(self) { return { shown: computed(() => self.visible.value && self.count.value > 0) }; } });
    const view = vi.fn();
    const fragment = vi.fn();
    const App = component({ model: Model, view(_props, self) {
      view();
      function details() { fragment(); if (!self.model.shown.value) return null; return h("aside", null, self.model.count); }
      return h("main", null, h("h1", null, self.model.count), details);
    } });
    const instance = root.run(() => Model.create({}));
    await root.render(() => h(App, { model: instance }));
    const heading = root.container.querySelector("h1");
    const aside = root.container.querySelector("aside");
    instance.count.value = 2;
    expect(root.container.querySelector("aside")).toBe(aside);
    expect(fragment).toHaveBeenCalledTimes(1);
    instance.visible.value = false;
    expect(root.container.querySelector("aside")).toBeNull();
    expect(fragment).toHaveBeenCalledTimes(2);
    instance.count.value = 3;
    expect(fragment).toHaveBeenCalledTimes(2);
    instance.visible.value = true;
    expect(root.container.querySelector("aside")).not.toBe(aside);
    expect(root.container.querySelector("h1")).toBe(heading);
    expect(view).toHaveBeenCalledTimes(1);
  });
  it("recreates even same-tag DOM when the structural fragment is invalidated", async ({ root }) => {
    const Model = staticModel({ data: { revision: f.number(1) } });
    const App = component({ model: Model, view(_props, self) {
      function editor() { return h("textarea", { title: String(self.model.revision.value), defaultValue: "fresh" }); }
      return editor;
    } });
    const instance = root.run(() => Model.create({}));
    await root.render(() => h(App, { model: instance }));
    const old = root.container.querySelector("textarea")!;
    old.value = "uncontrolled draft";
    instance.revision.value++;
    expect(root.container.querySelector("textarea")).not.toBe(old);
    expect(root.container.querySelector("textarea")!.value).toBe("fresh");
    expect(old.isConnected).toBe(false);
  });
  it("selects a ready model reactively; null displays nothing without disposing its owner", async ({ root }) => {
    const Model = staticModel({ data: { text: f.string() } });
    const Row = component({ model: Model, view: (_props, self) => h("p", null, self.model.text) });
    const [a, b] = root.run(() => [Model.create({ text: "A" }), Model.create({ text: "B" })]);
    const selected = store<typeof a | null>(a);
    await root.render(() => h(Row, { model: selected }));
    const first = root.container.querySelector("p");
    root.run(() => { selected.value = b; });
    expect(root.container.textContent).toBe("B");
    expect(root.container.querySelector("p")).not.toBe(first);
    root.run(() => { selected.value = null; });
    expect(root.container.querySelector("p")).toBeNull();
    expect([a.alive, b.alive]).toEqual([true, true]);
  });
  it("coalesces pending branch changes while awaiting outgoing lifecycle", async ({ root }) => {
    let release!: () => void;
    const wait = effect(() => new Promise<void>((resolve) => { release = resolve; }));
    const Model = staticModel({ with: [ui], data: { text: f.string() }, setup(self) {
      reaction({ on: self.unmounted, run: async () => { if (self.text.value === "A") await wait(); } });
    } });
    const Row = component({ model: Model, view: (_props, self) => h("p", null, self.model.text) });
    const [a, b, c] = root.run(() => ["A", "B", "C"].map((text) => Model.create({ text })));
    const selected = store<typeof a | null>(a);
    await root.render(() => h(Row, { model: selected }));
    const original = root.container.querySelector("p");
    root.run(() => { selected.value = b; });
    root.run(() => { selected.value = c; });
    expect(root.container.querySelector("p")).toBe(original);
    release();
    await vi.waitFor(() => expect(root.container.textContent).toBe("C"));
    expect(root.container.textContent).toBe("C");
    expect(collection(Model, root.scope).items).toHaveLength(3);
  });
});
