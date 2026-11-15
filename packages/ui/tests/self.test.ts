import { scope, scoped } from "@virentia/core";
import { f, staticModel } from "@virentia/core/models";
import { collection } from "../../core/lib/models/collection";
import { expect } from "vitest";
import { test } from "./support/vitest";
import { component, createContext, h, render, type ComponentSelf } from "../lib";
import { renderToString } from "../lib/server";

test("view self is typed, bound to its native model, and snapshots only its application", async ({ root }) => {
  const Theme = createContext("light");
  const Model = staticModel({ name: "Field", data: { title: f.string("field") } });
  const handles: ComponentSelf<typeof Model>[] = [];
  const Field = component({ model: Model, view(_props, self) {
    handles.push(self);
    return h("span", { id: self.elementId("label") }, self.context(Theme));
  } });
  const other = scoped(scope(), () => Model.create({ id: "other" }));
  const a = root.run(() => Model.create({ id: "a" }));
  const b = root.run(() => Model.create({ id: "b" }));
  await root.render(() => h(Theme.Provider, { value: "dark" }, h(Field, { model: a })));
  expect(handles[0]!.model).toBe(a);
  expect(handles[0]!.id).toBe("a");
  expect(handles[0]!.instances).toEqual([a, b]);
  expect(handles[0]!.instances).not.toContain(other);
  expect(root.container.textContent).toBe("dark");
  await root.render(() => h(Field, { model: b }));
  expect(handles[0]!.id).toBe("a");
  expect(handles[1]!.id).toBe("b");
  expect(collection(Model, root.scope).items).toEqual([a, b]);
});

test("named DOM IDs use explicit model identity and root prefix in SSR and hydration", async ({ root }) => {
  const Model = staticModel({ name: "Input" });
  const Field = component({ model: Model, view: (_props, self) => h("input", { id: self.elementId("input") }) });
  const html = renderToString(() => h(Field, { id: "field" }), { scope: scope(), identifierPrefix: "test" });
  await root.hydrate(() => h(Field, { id: "field" }), html);
  expect(root.container.querySelector("input")!.id).toBe("ui:test:Input:field:input");
});

test("keeps distinct frozen view selves and root prefixes across retained remounts", async ({ root }) => {
  const Model = staticModel({ name: "RetainedViewSelf", data: { count: f.number(0) } });
  const selves: ComponentSelf<typeof Model>[] = [];
  const View = component({ model: Model, keep: true, view(_props, self) {
    selves.push(self);
    expect(Object.isFrozen(self)).toBe(true);
    expect(Object.keys(self)).toEqual(["model", "scope"]);
    return h("p", { id: self.elementId("text") }, self.model.count);
  } });
  const a = root.document.createElement("div"), b = root.document.createElement("div");
  const first = render(() => h(View, { id: "row" }), a, { scope: root.scope, identifierPrefix: "a" });
  const model = selves[0].model;
  await first();
  expect(model.alive).toBe(true);
  const second = render(() => h(View, { model }), b, { scope: root.scope, identifierPrefix: "b" });
  try {
    expect(selves[1]).not.toBe(selves[0]);
    expect(selves[1].model).toBe(model);
    expect(selves[0].elementId("text")).toBe("ui:a:RetainedViewSelf:row:text");
    expect(selves[1].elementId("text")).toBe("ui:b:RetainedViewSelf:row:text");
    model.count.value = 2;
    expect(b.textContent).toBe("2");
    expect(a.childNodes).toHaveLength(0);
  } finally { await second(); }
});

test("does not retarget a captured self's context when its model is displayed again", async ({ root }) => {
  const Theme = createContext("default");
  const Model = staticModel({});
  const model = root.run(() => Model.create({ id: "row" }));
  const selves: ComponentSelf<typeof Model>[] = [];
  const View = component({ model: Model, view(_props, self) {
    selves.push(self);
    return h("p", null, self.context(Theme));
  } });
  await root.render(() => h(Theme.Provider, { value: "first" }, h(View, { model })));
  await root.render(() => h(Theme.Provider, { value: "second" }, h(View, { model })));
  expect(selves[0].context(Theme)()).toBe("first");
  expect(selves[1].context(Theme)()).toBe("second");
  expect(root.container.textContent).toBe("second");
});
