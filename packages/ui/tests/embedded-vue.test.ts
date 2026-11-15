import { scope } from "@virentia/core";
import { f, model } from "@virentia/core/models";
import { collection } from "../../core/lib/models/collection";
import { createApp, h as v, nextTick, ref as vueRef, type App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import { action, component, h } from "../lib";
import { asVue } from "../lib/vue";

const apps: App[] = [];
afterEach(() => { for (const app of apps.splice(0)) app.unmount(); document.body.textContent = ""; });
const counter = () => {
  const Model = model({ data: { label: f.string("Count"), count: f.number(0) },
    setup(self) { return { increment: action(() => { self.count.value++; }) }; } });
  const view = vi.fn((_props, self) => h("button", { onClick: self.model.increment }, self.model.label, ":", self.model.count));
  const View = component({ model: Model, root: "button", view });
  return { Model, view, Counter: asVue(View) };
};
describe("Virentia inside Vue", () => {
  it("receives a ready model without a provider, renders no wrapper and updates DOM without Vue rerenders", async () => {
    const { Model, Counter, view } = counter();
    const instance = collection(Model, scope()).add({ id: "one" });
    const parent = vi.fn();
    const target = document.createElement("div"); document.body.append(target);
    const app = createApp({ setup: () => () => { parent(); return v("main", null, [v("i", "before"), v(Counter, { model: instance }), v("i", "after")]); } });
    apps.push(app); app.mount(target);
    const button = target.querySelector("button")!;
    button.click(); await nextTick();
    expect(button.textContent).toBe("Count:1");
    expect([...target.querySelector("main")!.children].map((element) => element.tagName)).toEqual(["I", "BUTTON", "I"]);
    expect(parent).toHaveBeenCalledTimes(1); expect(view).toHaveBeenCalledTimes(1);
  });
  it("commits host prop changes to the native model on the same DOM root", async () => {
    const { Counter, view } = counter();
    const label = vueRef("A");
    const target = document.createElement("div"); document.body.append(target);
    const app = createApp(() => v(Counter, { label: label.value })); apps.push(app); app.mount(target);
    const button = target.querySelector("button")!;
    button.click();
    label.value = "B"; await nextTick();
    expect(target.querySelector("button")).toBe(button);
    expect(button.textContent).toBe("B:1");
    expect(view).toHaveBeenCalledTimes(1);
  });
  it("does not overwrite Virentia-owned input state during a host update", async () => {
    const Model = model({ data: { value: f.string("native"), version: f.number(0) } });
    const View = component({ model: Model, root: "input", view: (_props, self) => h("input", { value: self.model.value }) });
    const Field = asVue(View), version = vueRef(0);
    const instance = collection(Model, scope()).add({});
    const target = document.createElement("div"); document.body.append(target);
    const app = createApp(() => v(Field, { model: instance, version: version.value })); apps.push(app); app.mount(target);
    const input = target.querySelector("input")!;
    instance.value.value = "changed";
    version.value++; await nextTick();
    expect(target.querySelector("input")).toBe(input);
    expect(input.value).toBe("changed");
  });
});
