import { scope, store } from "@virentia/core";
import { f, model, staticModel } from "@virentia/core/models";
import { collection } from "../../core/lib/models/collection";
import { describe, expect, vi } from "vitest";
import { it } from "./support/vitest";
import { component, h, render } from "../lib";

describe("native component identity and props", () => {
  it("derives IDs from model configuration, with explicit JSX id taking precedence", async ({ root }) => {
    const Model = staticModel({ data: { slug: f.string() }, id: (props) => props.slug });
    const View = component({ model: Model, view: (_props, self) => h("p", null, self.id) });
    await root.render(() => [h(View, { slug: "derived" }), h(View, { slug: "ignored", id: "explicit" })]);
    expect(collection(Model, root.scope).ids).toEqual(["derived", "explicit"]);
  });
  it("generates fresh automatic IDs, independent of tree position", async ({ root }) => {
    const Model = model({});
    const View = component({ model: Model, view: (_props, self) => h("p", null, self.id) });
    await root.render(() => h(View));
    const first = collection(Model, root.scope).items[0]!;
    await root.render(() => null);
    expect(first.alive).toBe(false);
    await root.render(() => h(View));
    expect(collection(Model, root.scope).items[0]!.id).not.toBe(first.id);
  });
  it("supports per-instance keep overrides without retaining DOM", async ({ root }) => {
    const Model = model({ data: { count: f.number(0) } });
    const View = component({ model: Model, keep: true, view: (_props, self) => h("p", null, self.model.count) });
    await root.render(() => [h(View, { id: "kept" }), h(View, { id: "temporary", keep: false })]);
    const kept = collection(Model, root.scope).get("kept")!;
    const temporary = collection(Model, root.scope).get("temporary")!;
    const node = root.container.querySelector("p");
    kept.count.value = 9;
    await root.render(() => null);
    expect(kept.alive).toBe(true);
    expect(temporary.alive).toBe(false);
    await root.render(() => h(View, { id: "kept" }));
    expect(root.container.querySelector("p")).not.toBe(node);
    expect(root.container.textContent).toBe("9");
  });
  it("retargets explicitly reactive inputs without invoking view or rebuilding DOM", async ({ root }) => {
    const a = store("A"), b = store("B");
    const Model = staticModel({ data: { title: f.string() } });
    const view = vi.fn((props) => h("p", null, props.title));
    const View = component({ model: Model, view });
    const input = store(a);
    // A live prop descriptor is the commit bridge used by host adapters.
    await root.render(() => h(View, { id: "one", get title() { return input.value; } }));
    const element = root.container.querySelector("p");
    root.run(() => { a.value = "Alpha"; });
    expect(element!.textContent).toBe("Alpha");
    root.run(() => { input.value = b; });
    expect(element!.textContent).toBe("B");
    root.run(() => { a.value = "obsolete"; b.value = "Beta"; });
    expect(element!.textContent).toBe("Beta");
    expect(root.container.querySelector("p")).toBe(element);
    expect(view).toHaveBeenCalledTimes(1);
    expect(collection(Model, root.scope).get("one")!.title.value).toBe("Beta");
  });
  it("rejects a reactive creation id before creating a model or changing DOM", () => {
    const Model = staticModel({});
    const View = component({ model: Model, view: () => h("p") });
    const container = document.createElement("div");
    expect(() => render(() => h(View, { id: store("invalid") } as never), container, { scope: scope() })).toThrow("creation string");
    expect(container.childNodes).toHaveLength(0);
  });
  it("lazily connects a plain input when it becomes a unit, then disconnects it again", async ({ root }) => {
    const a = store("A"), b = store("B");
    const source = store<string | typeof a>("plain");
    const Model = staticModel({ data: { title: f.string("") } });
    const view = vi.fn((_props, self) => h("p", null, self.model.title));
    const View = component({ model: Model, view });
    await root.render(() => h(View, { id: "one", get title() { return source.value; } }));
    const element = root.container.querySelector("p")!;
    expect(element.textContent).toBe("plain");
    root.run(() => { source.value = a; });
    expect(element.textContent).toBe("A");
    root.run(() => { a.value = "Alpha"; });
    expect(element.textContent).toBe("Alpha");
    root.run(() => { source.value = "again"; a.value = "obsolete"; });
    expect(element.textContent).toBe("again");
    root.run(() => { source.value = b; });
    expect(element.textContent).toBe("B");
    expect(root.container.querySelector("p")).toBe(element);
    expect(view).toHaveBeenCalledTimes(1);
  });
  it("allows alternative views sequentially, never two displays of one native instance", async ({ root }) => {
    const Model = staticModel({ data: { text: f.string("hello") } });
    const Full = component({ model: Model, view: (_props, self) => h("article", null, self.model.text) });
    const Compact = component({ model: Model, view: (_props, self) => h("small", null, self.model.text) });
    const instance = root.run(() => Model.create({ id: "one" }));
    await root.render(() => h(Full, { model: instance }));
    const second = document.createElement("div");
    expect(() => render(() => h(Compact, { model: instance }), second, { scope: root.scope })).toThrow("only one active display");
    expect(root.container.querySelector("article")).not.toBeNull();
    await root.render(() => h(Compact, { model: instance }));
    expect(root.container.querySelector("small")?.textContent).toBe("hello");
  });
});
