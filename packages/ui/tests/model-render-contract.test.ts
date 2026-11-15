import { computed, effect, event, reaction, scope, scoped, store } from "@virentia/core";
import { f, model, staticModel } from "@virentia/core/models";
import { collection } from "../../core/lib/models/collection";
import { describe, expect, test, vi } from "vitest";
import { it } from "./support/vitest";
import { action, component, createElement as h, hydrate, ref, render, ui } from "../lib";
import { renderToString } from "../lib/server";

describe("model-first renderer contract", () => {
  it("rejects user unit declarations in view and releases uncommitted kept models", async ({ root }) => {
    for (const declare of [() => store(0), () => computed(() => 1), () => event(), () => action(() => {}), () => effect(async () => {})]) {
      const Model = model({});
      const View = component({ model: Model, keep: true, view() { declare(); return h("p"); } });
      expect(() => render(() => h(View, { id: "invalid" }), root.container, { scope: root.scope })).toThrow("in the model, not in view");
      expect(collection(Model, root.scope).ids).toEqual([]);
      expect(root.container.childNodes).toHaveLength(0);
    }
  });
  for (const define of [model, staticModel]) {
    it(`uses an existing ${define.name} definition and instance without a hidden model`, async ({ root }) => {
      const setup = vi.fn();
      const Model = define({
        with: [ui], data: { count: f.number(0) },
        setup(self) {
          setup();
          const increment = action(() => { self.count.value++; });
          return { increment };
        },
      });
      const view = vi.fn((_props, self) => h("button", { onClick: self.model.increment }, self.model.count));
      const Counter = component({ model: Model, view });
      const instance = root.run(() => Counter.model.create({ id: "counter", count: 2 }));
      expect(setup).toHaveBeenCalledTimes(1);
      expect(view).not.toHaveBeenCalled();
      await root.render(() => h(Counter, { model: instance }));
      const button = root.container.querySelector("button")!;
      button.click();
      expect(button.textContent).toBe("3");
      expect(root.container.querySelector("button")).toBe(button);
      expect(view).toHaveBeenCalledTimes(1);
      expect(Counter.model).toBe(Model);
      await root.render(() => null);
      expect(instance.alive).toBe(true);
      await root.render(() => h(Counter, { model: instance }));
      expect(root.container.querySelector("button")).not.toBe(button);
      expect(root.container.textContent).toBe("3");
      expect(view).toHaveBeenCalledTimes(2);
    });
  }

  const Shared = staticModel({
    with: [ui], data: { count: f.number(0) },
    setup(self) {
      const input = ref<HTMLInputElement>();
      const increment = action(() => { self.count.value++; });
      return { input, increment };
    },
  });
  const SharedView = component({
    model: Shared,
    view: (_props, self) => h("section", null,
      h("input", { ref: self.model.input, value: self.model.count }),
      h("button", { onClick: self.model.increment }, self.model.count)),
  });
  for (const value of [10, 20, 30]) {
    test.concurrent(`isolates shared units and refs in concurrent scope ${value}`, async () => {
      const appScope = scope();
      const page = document.implementation.createHTMLDocument("parallel model test");
      const container = page.createElement("div");
      page.body.append(container);
      const instance = scoped(appScope, () => SharedView.model.create({ id: "same", count: value }));
      const unmount = render(() => h(SharedView, { model: instance }), container, { scope: appScope });
      try {
        await instance.increment();
        expect(instance.count.value).toBe(value + 1);
        expect(instance.input.value).toBe(container.querySelector("input"));
        expect(instance.input.value!.value).toBe(String(value + 1));
        await unmount();
        expect(instance.input.value).toBeNull();
        expect(instance.alive).toBe(true);
      } finally { await unmount(); await instance.dispose(); }
    });
  }

  it("recreates only a conditional fragment while permanent bindings keep their DOM", async ({ root }) => {
    const ChildModel = staticModel({ data: { title: f.string("Details") } });
    const Child = component({ model: ChildModel, view: (_props, self) => h("aside", null, self.model.title) });
    const AppModel = staticModel({
      data: { count: f.number(1) },
      setup(self) { return { visible: computed(() => self.count.value > 0) }; },
    });
    const views = vi.fn();
    const App = component({ model: AppModel, view(_props, self) {
      views();
      function details() { if (!self.model.visible.value) return null; return h(Child); }
      return h("main", null, h("h1", null, self.model.count), details);
    } });
    const app = root.run(() => App.model.create({ id: "app" }));
    await root.render(() => h(App, { model: app }));
    const heading = root.container.querySelector("h1");
    const aside = root.container.querySelector("aside");
    root.run(() => { app.count.value = 2; });
    expect(root.container.querySelector("aside")).toBe(aside);
    root.run(() => { app.count.value = 0; });
    await Promise.resolve();
    expect(root.container.querySelector("aside")).toBeNull();
    root.run(() => { app.count.value = 1; });
    expect(root.container.querySelector("aside")).not.toBe(aside);
    expect(root.container.querySelector("h1")).toBe(heading);
    expect(views).toHaveBeenCalledTimes(1);
  });

  it("keeps a configured model, not its DOM or refs", async ({ root }) => {
    const Counter = component({ model: Shared, keep: true, view: SharedView });
    await root.render(() => h(Counter, { id: "kept" }));
    const instance = collection(Shared, root.scope).get("kept")!;
    const original = instance.input.value;
    await instance.increment();
    await root.render(() => null);
    expect(instance.alive).toBe(true);
    expect(instance.input.value).toBeNull();
    await root.render(() => h(Counter, { id: "kept" }));
    expect(collection(Shared, root.scope).get("kept")).toBe(instance);
    expect(instance.input.value).not.toBe(original);
    expect(instance.count.value).toBe(1);
  });

  it("awaits unmounted before removing DOM, clearing refs, or disposing the model", async ({ root }) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const wait = effect(() => gate);
    const seen: boolean[] = [];
    const Model = staticModel({ with: [ui], setup(self) {
      const input = ref<HTMLInputElement>();
      reaction({ on: self.unmounted, run: async () => {
        seen.push(input.value?.isConnected === true);
        await wait();
        seen.push(input.value?.isConnected === true);
      } });
      return { input };
    } });
    const View = component({ model: Model, view: (_props, self) => h("input", { ref: self.model.input }) });
    await root.render(() => h(View, { id: "async" }));
    const instance = collection(Model, root.scope).get("async")!;
    const original = instance.input.value;
    const disposal = instance.dispose();
    expect(instance.alive).toBe(true);
    expect(instance.input.value).toBe(original);
    expect(root.container.querySelector("input")).toBe(original);
    release();
    await disposal;
    expect(seen).toEqual([true, true]);
    expect(instance.alive).toBe(false);
    expect(root.container.querySelector("input")).toBeNull();
  });

  it("rejects cross-scope models before changing a root's existing DOM", () => {
    const first = scope(), second = scope();
    const instance = scoped(first, () => Shared.create({ id: "same" }));
    const container = document.createElement("div");
    const existing = document.createElement("p");
    container.append(existing);
    expect(() => render(() => h(SharedView, { model: instance }), container, { scope: second })).toThrow("different render scope");
    expect(container.firstChild).toBe(existing);
    expect(container.childNodes.length).toBe(1);
  });

  it("hydrates scalar bindings and refs on the existing DOM", async ({ root }) => {
    const serverScope = scope();
    const serverModel = scoped(serverScope, () => Shared.create({ id: "ssr", count: 7 }));
    const html = renderToString(() => h(SharedView, { model: serverModel }), { scope: serverScope });
    const clientModel = root.run(() => Shared.create({ id: "ssr", count: 7 }));
    root.container.innerHTML = html;
    const input = root.container.querySelector("input");
    const button = root.container.querySelector("button");
    const detach = hydrate(() => h(SharedView, { model: clientModel }), root.container, { scope: root.scope });
    expect(clientModel.input.value).toBe(input);
    await clientModel.increment();
    expect(root.container.querySelector("button")).toBe(button);
    expect(button!.textContent).toBe("8");
    await detach();
  });
});
