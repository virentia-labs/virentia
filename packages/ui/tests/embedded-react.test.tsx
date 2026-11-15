// @vitest-environment happy-dom
import { scope } from "@virentia/core";
import { f, model } from "@virentia/core/models";
import { collection } from "../../core/lib/models/collection";
import { ScopeProvider } from "@virentia/react";
import { act, createElement as r, StrictMode, Suspense, startTransition } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { action, component, h } from "../lib";
import { asReact } from "../lib/react";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const roots = new Set<Root>();
afterEach(async () => { for (const root of roots) await act(async () => root.unmount()); roots.clear(); document.body.textContent = ""; });

const defineCounter = (view = vi.fn()) => {
  const Model = model({ data: { label: f.string("Count"), count: f.number(0) },
    setup(self) { return { increment: action(() => { self.count.value++; }) }; } });
  const View = component({ model: Model, root: "button", keep: true, view(_props, self) {
    view(); return h("button", { class: "native", onClick: self.model.increment }, self.model.label, ":", self.model.count);
  } });
  return { Model, View, Counter: asReact(View), view };
};
async function mount(children: any) {
  const target = document.createElement("div"); document.body.append(target);
  const root = createRoot(target); roots.add(root);
  await act(async () => root.render(children));
  return { target, root, update: (children: any) => act(async () => root.render(children)) };
}

describe("Virentia inside React", () => {
  it("uses the actual root among siblings and never calls React for a native state update", async () => {
    const { Counter, view } = defineCounter();
    const parent = vi.fn();
    function Parent() { parent(); return r("main", null, r("i", null, "before"), r(Counter), r("i", null, "after")); }
    const { target } = await mount(r(Parent));
    const button = target.querySelector("button")!;
    expect([...target.querySelector("main")!.children].map((node) => node.tagName)).toEqual(["I", "BUTTON", "I"]);
    await act(async () => button.click());
    expect(button.textContent).toBe("Count:1");
    expect(target.querySelector("button")).toBe(button);
    expect(view).toHaveBeenCalledTimes(1); expect(parent).toHaveBeenCalledTimes(1);
  });
  it("publishes ordinary host props only after commit without repeating native view", async () => {
    const { Counter, view } = defineCounter();
    const home = scope();
    const provided = (label: string) => r(ScopeProvider, { scope: home }, r(Counter, { id: "one", label }));
    const { target, update } = await mount(provided("A"));
    const button = target.querySelector("button")!;
    await act(async () => button.click());
    await update(provided("B"));
    expect(target.querySelector("button")).toBe(button);
    expect(button.textContent).toBe("B:1");
    expect(view).toHaveBeenCalledTimes(1);
  });
  it("ignores props from an abandoned suspended host render", async () => {
    const { Counter } = defineCounter();
    const home = scope(), pending = new Promise<void>(() => {});
    function Gate({ block }: { block: boolean }) { if (block) throw pending; return null; }
    const tree = (label: string, block: boolean) => r(ScopeProvider, { scope: home },
      r(Suspense, { fallback: "waiting" }, r(Counter, { id: "one", label }), r(Gate, { block })));
    const { target, root, update } = await mount(tree("committed", false));
    const button = target.querySelector("button")!;
    await act(async () => { startTransition(() => root.render(tree("abandoned", true))); });
    expect(button.textContent).toBe("committed:0");
    await update(tree("latest", false));
    expect(button.textContent).toBe("latest:0");
  });
  it("gets scope from a ready native model without requiring a provider", async () => {
    const { Model, Counter } = defineCounter();
    const instance = collection(Model, scope()).add({ id: "ready", label: "Ready" });
    const { target } = await mount(r(Counter, { model: instance }));
    await act(async () => target.querySelector("button")!.click());
    expect(instance.count.value).toBe(1);
  });
  it("survives StrictMode replay and keeps model state across true unmount/remount", async () => {
    const { Model, Counter } = defineCounter();
    const home = scope();
    const tree = (show: boolean) => r(StrictMode, null, r(ScopeProvider, { scope: home }, show ? r(Counter, { id: "kept" }) : null));
    const { target, update } = await mount(tree(true));
    await vi.waitFor(() => expect(target.querySelector("button")?.textContent).toBe("Count:0"));
    const first = target.querySelector("button")!;
    await act(async () => first.click());
    await update(tree(false));
    const instance = collection(Model, home).get("kept")!;
    expect(instance.count.value).toBe(1);
    await update(tree(true));
    await vi.waitFor(() => expect(target.querySelector("button")?.textContent).toBe("Count:1"));
    expect(target.querySelector("button")).not.toBe(first);
    expect(collection(Model, home).get("kept")).toBe(instance);
  });
});
