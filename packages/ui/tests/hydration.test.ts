import { getOwner, scope, serialize } from "@virentia/core";
import { f, model, staticModel } from "@virentia/core/models";
import { collection } from "../../core/lib/models/collection";
import { describe, expect, vi } from "vitest";
import { it } from "./support/vitest";
import { action, component, For, h, hydrate } from "../lib";
import { renderToString } from "../lib/server";
import type { RootState, UIContext } from "../lib/runtime";

describe("native SSR hydration", () => {
  for (const define of [model, staticModel]) {
    it(`restores ${define.name} state and generated identity before view, preserving existing DOM`, async ({ root }) => {
      const Model = define({ name: "HydratedCounter", data: { count: f.number(0) }, setup(self) {
        return { increment: action(() => { self.count.value++; }) };
      } });
      const view = vi.fn((_props, self) => h("button", { id: self.elementId("button"), onClick: self.model.increment }, self.model.count));
      const Counter = component({ model: Model, view });
      const server = scope();
      const html = renderToString(() => h(Counter, { count: 7 }), { scope: server, identifierPrefix: "test" });
      const snapshot = serialize(server);
      const client = scope({ snapshot });
      root.container.innerHTML = html;
      const button = root.container.querySelector("button")!;
      const text = [...button.childNodes].find((node) => node.nodeType === 3);
      const detach = hydrate(() => h(Counter, { count: 0 }), root.container, { scope: client, identifierPrefix: "test" });
      try {
        expect(root.container.querySelector("button")).toBe(button);
        const instance = collection(Model, client).items[0]!;
        expect(instance.id).toBe(collection(Model, server).items[0]!.id);
        expect(instance.count.value).toBe(7);
        button.click();
        expect(instance.count.value).toBe(8);
        expect(button.textContent).toBe("8");
        expect([...button.childNodes]).toContain(text);
        expect(collection(Model, server).items[0]!.count.value).toBe(7);
        expect(view).toHaveBeenCalledTimes(2);
      } finally { await detach(); }
    });
  }
  it("hydrates model rows, then moves their exact nodes through relation operations", async ({ root }) => {
    const RowModel = staticModel({ name: "SSRRow", data: { title: f.string() } });
    const Row = component({ model: RowModel, view: (_props, self) => h("input", { value: self.model.title }) });
    const view = () => h(For, { each: RowModel, view: Row });
    const server = scope();
    collection(RowModel, server).add([{ id: "a", title: "A" }, { id: "b", title: "B" }]);
    const html = renderToString(view, { scope: server, identifierPrefix: "test" });
    const rows = collection(RowModel, root.scope);
    rows.add([{ id: "a", title: "A" }, { id: "b", title: "B" }]);
    root.container.innerHTML = html;
    const [a, b] = root.container.querySelectorAll("input");
    const detach = hydrate(view, root.container, { scope: root.scope, identifierPrefix: "test" });
    try {
      expect([...root.container.querySelectorAll("input")]).toEqual([a, b]);
      rows.get("a")!.title.value = "changed";
      expect(a.value).toBe("changed");
    } finally { await detach(); }
  });
  it("hydrates HTML, SVG, raw-text and controlled native form values", async ({ root }) => {
    const Model = staticModel({ data: { value: f.string("hello <&"), selected: f.string("b") } });
    const View = component({ model: Model, view: (_props, self) => h("main", null,
      h("svg", { viewBox: "0 0 10 10" }, h("circle", { strokeWidth: 2 })),
      h("input", { defaultValue: "draft" }), h("textarea", { value: self.model.value }),
      h("select", { value: self.model.selected }, h("option", { value: "a" }, "A"), h("option", { value: "b" }, "B"))) });
    const html = renderToString(() => h(View, { id: "forms" }), { scope: scope(), identifierPrefix: "test" });
    await root.hydrate(() => h(View, { id: "forms" }), html);
    const instance = collection(Model, root.scope).get("forms")!;
    const textarea = root.container.querySelector("textarea")!;
    instance.value.value = "updated"; instance.selected.value = "a";
    expect(root.container.querySelector("textarea")).toBe(textarea);
    expect(textarea.value).toBe("updated");
    expect(root.container.querySelector("select")!.value).toBe("a");
  });
  it("reports a mismatch without replacing server DOM or leaving partial event listeners", () => {
    const click = vi.fn();
    const clicked = action(click);
    const container = document.createElement("div");
    container.innerHTML = renderToString(() => h("div", null, h("button", { onClick: clicked }, "server")), { scope: scope() });
    const html = container.innerHTML, button = container.querySelector("button")!;
    expect(() => hydrate(() => h("div", null, h("button", { onClick: clicked }, "client")), container, { scope: scope() })).toThrow("Hydration mismatch");
    expect(container.innerHTML).toBe(html);
    expect(container.querySelector("button")).toBe(button);
    button.click();
    expect(click).not.toHaveBeenCalled();
  });
  it("releases failed hydration cursors while a supplied model stays alive", async ({ root }) => {
    const Model = staticModel({ data: { count: f.number(0) } });
    let hydration: RootState["hydration"];
    const View = component({
      model: Model,
      view(_props, self) {
        hydration = (getOwner() as unknown as UIContext).root.hydration;
        return h("p", null, self.model.count);
      },
    });
    const instance = root.run(() => Model.create({ id: "retained" }));
    const html = renderToString(() => h(View, { id: "retained", count: 1 }), { scope: scope() });
    root.container.innerHTML = html;
    const paragraph = root.container.querySelector("p");
    expect(() =>
      hydrate(() => h(View, { model: instance }), root.container, { scope: root.scope }),
    ).toThrow("Hydration mismatch");
    expect(hydration?.failed).toBe(true);
    expect(hydration?.cursors.size).toBe(0);
    expect(root.container.querySelector("p")).toBe(paragraph);
    expect(root.container.innerHTML).toBe(html);
    expect(instance.alive).toBe(true);
    expect(instance.count.value).toBe(0);
  });
});
