import { getOwner, scope, store } from "@virentia/core";
import { f, staticModel } from "@virentia/core/models";
import {
  getActiveScope,
  resolveStoreSid,
  setActiveScope,
  setOwner,
  setSidScopeFrame,
  withUnitDeclarationTracker,
} from "@virentia/core/internal";
import { expect, vi } from "vitest";
import { component, h, render } from "../lib";
import { test } from "./support/vitest";

test("restores the enclosing declaration, scope, owner and SID frames after a failed view", async ({ root }) => {
  const Model = staticModel({ data: { count: f.number(0) } });
  const other = scope();
  const before = { scope: getActiveScope(), owner: getOwner(), sid: resolveStoreSid("outside") };
  const Broken = component({ model: Model, view() {
    setActiveScope(other);
    setOwner(null);
    setSidScopeFrame("failed-view");
    throw Error("view failed");
  } });
  const declared: string[] = [];
  withUnitDeclarationTracker((kind) => { declared.push(kind); }, () => {
    expect(() => render(() => h(Broken, { id: "broken" }), root.container, { scope: root.scope }))
      .toThrow("view failed");
    store(1);
  });
  expect(declared).toEqual(["store"]);
  expect({ scope: getActiveScope(), owner: getOwner(), sid: resolveStoreSid("outside") }).toEqual(before);
  expect(root.container.childNodes).toHaveLength(0);
  expect(root.run(() => Model.get("broken"))).toBeNull();
  const view = vi.fn((_props, self) => h("p", null, self.model.count));
  const Good = component({ model: Model, view });
  const detach = render(() => h(Good, { id: "good" }), root.container, { scope: root.scope });
  try {
    const text = root.container.querySelector("p")!.firstChild;
    root.run(() => { Model.get("good")!.count.value = 2; });
    expect(text!.textContent).toBe("2");
    expect(root.container.querySelector("p")!.firstChild).toBe(text);
    expect(view).toHaveBeenCalledTimes(1);
  } finally { await detach(); }
});

test("rejects model-unit declarations in view without leaving its purity guard active", () => {
  const Model = staticModel({});
  const View = component({ model: Model, view() { store(0); return null; } });
  const container = document.createElement("div");
  expect(() => render(() => h(View), container, { scope: scope() })).toThrow("Declare store");
  expect(() => store(1)).not.toThrow();
  expect(container.childNodes).toHaveLength(0);
});

test("does not confuse a cached model with a model created by reentrant rendering", async ({ root }) => {
  const Model = staticModel({ data: { count: f.number(0) } });
  const NestedModel = staticModel({ data: { count: f.number(1) } });
  const nested = root.document.createElement("div");
  const Nested = component({ model: NestedModel, view: (_props, self) => h("b", null, self.model.count) });
  const existing = root.run(() => Model.create({ id: "existing" }));
  const alive = Object.getOwnPropertyDescriptor(existing, "alive")!.get!;
  let entered = false, detach: (() => Promise<void>) | undefined;
  Object.defineProperty(existing, "alive", { configurable: true, get() {
    if (!entered) {
      entered = true;
      detach = render(() => h(Nested, { id: "new" }), nested, { scope: root.scope });
    }
    return alive.call(existing);
  } });
  const Broken = component({ model: Model, keep: true, view() { throw Error("outer failed"); } });
  try {
    expect(() => render(() => h(Broken, { id: "existing" }), root.container, { scope: root.scope }))
      .toThrow("outer failed");
    expect(entered).toBe(true);
    expect(existing.alive).toBe(true);
    expect(root.run(() => Model.get("existing"))).toBe(existing);
    expect(root.container.childNodes).toHaveLength(0);
    expect(nested.textContent).toBe("1");
  } finally { await detach?.(); }
});
