import { effect, reaction, scope } from "@virentia/core";
import { children, f, staticModel } from "@virentia/core/models";
import { describe, expect } from "vitest";
import { it } from "./support/vitest";
import { component, h, ref, ui } from "../lib";
import { renderToString } from "../lib/server";

describe("native ui trait lifecycle", () => {
  it("routes shared units to each instance and starts parent before children with all refs ready", async ({ root }) => {
    const order: string[] = [];
    const ChildModel = staticModel({ with: [ui], setup(self) {
      const input = ref<HTMLInputElement>();
      reaction({ on: self.mounted, run: () => {
        expect(input.value?.isConnected).toBe(true); order.push("mount:" + self.id);
      } });
      reaction({ on: self.unmounted, run: () => {
        expect(input.value?.isConnected).toBe(true); order.push("unmount:" + self.id);
      } });
      return { input };
    } });
    const ParentModel = staticModel({ with: [ui], data: { children: children.many(ChildModel) }, setup(self) {
      reaction({ on: self.mounted, run: () => {
        expect(self.children.items.every((child) => child.input.value?.isConnected)).toBe(true);
        order.push("mount:parent");
      } });
      reaction({ on: self.unmounted, run: () => order.push("unmount:parent") });
    } });
    const Child = component({ model: ChildModel, view: (_props, self) => h("input", { ref: self.model.input }) });
    const Parent = component({ model: ParentModel, view: (_props, self) =>
      h("section", null, self.model.children.items.map((child) => h(Child, { model: child }))) });
    const parent = root.run(() => ParentModel.create({ id: "parent", children: [{ id: "a" }, { id: "b" }] }));
    await root.render(() => h(Parent, { model: parent }));
    expect(order).toEqual(["mount:parent", "mount:a", "mount:b"]);
    await root.render(() => null);
    expect(order).toEqual(["mount:parent", "mount:a", "mount:b", "unmount:parent", "unmount:a", "unmount:b"]);
    expect(parent.children.items.every((child) => child.input.value === null)).toBe(true);
  });

  it("skips lifecycle on the server and fires mounted after hydration", async ({ root }) => {
    const log: string[] = [];
    const Model = staticModel({ name: "Lifecycle", with: [ui], data: { count: f.number(0) }, setup(self) {
      reaction({ on: self.mounted, run: () => { log.push("mounted"); self.count.value++; } });
      reaction({ on: self.unmounted, run: () => log.push("unmounted") });
    } });
    const View = component({ model: Model, view: (_props, self) => h("p", null, self.model.count) });
    const html = renderToString(() => h(View, { id: "one" }), { scope: scope(), identifierPrefix: "test" });
    expect(log).toEqual([]);
    await root.hydrate(() => h(View, { id: "one" }), html);
    expect(root.container.textContent).toBe("1");
    expect(log).toEqual(["mounted"]);
    await root.render(() => null);
    expect(log).toEqual(["mounted", "unmounted"]);
  });

  it("keeps scalar updates active during asynchronous unmounted for exit animations", async ({ root }) => {
    let release!: () => void;
    const gate = effect(() => new Promise<void>((resolve) => { release = resolve; }));
    const Model = staticModel({ with: [ui], data: { className: f.string("open") }, setup(self) {
      reaction({ on: self.unmounted, run: async () => { self.className.value = "closing"; await gate(); } });
    } });
    const View = component({ model: Model, view: (_props, self) => h("aside", { class: self.model.className }) });
    await root.render(() => h(View));
    const aside = root.container.querySelector("aside")!;
    const closing = root.render(() => null);
    expect(aside.isConnected).toBe(true);
    expect(aside.className).toBe("closing");
    release();
    await closing;
    expect(aside.isConnected).toBe(false);
  });
});
