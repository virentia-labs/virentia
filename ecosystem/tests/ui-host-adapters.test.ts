import { expect, it } from "vitest";
import { scope, scoped } from "@virentia/core";
import { f, staticModel } from "@virentia/core/models";
import { action, component, h } from "@virentia/ui";
import { asReact } from "@virentia/ui/react";
import { asVue } from "@virentia/ui/vue";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { createApp, h as vueElement, nextTick } from "vue";

function counter(name: string) {
  const Model = staticModel({
    name, data: { count: f.number(0) },
    setup(self) { return { increment: action(() => { self.count.value++; }) }; },
  });
  const View = component({
    model: Model, root: "button", keep: true,
    view: (_props, self) => h("button", { onClick: self.model.increment }, self.model.count),
  });
  const first = scoped(scope(), () => Model.create({ id: "counter" }));
  const second = scoped(scope(), () => Model.create({ id: "counter" }));
  return { View, first, second };
}

it("keeps native models and cleanup isolated inside a React consumer bundle", async () => {
  const { View, first, second } = counter("BundledReactCounter"), Counter = asReact(View);
  const host = document.createElement("div"), root = createRoot(host);
  const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previous = environment.IS_REACT_ACT_ENVIRONMENT;
  environment.IS_REACT_ACT_ENVIRONMENT = true;
  try {
    await act(async () => root.render(createElement("section", null,
      createElement(Counter, { model: first }), createElement(Counter, { model: second }))));
    const buttons = host.querySelectorAll("button");
    expect(buttons).toHaveLength(2);
    await act(async () => buttons[0]!.click());
    expect(first.count.value).toBe(1);
    expect(second.count.value).toBe(0);
    expect(host.querySelector("button")).toBe(buttons[0]);
    expect(host.textContent).toBe("10");
    await act(async () => root.unmount());
    expect(host.childNodes).toHaveLength(0);
    buttons[0]!.click();
    expect(first.count.value).toBe(1);
  } finally {
    await act(async () => root.unmount());
    environment.IS_REACT_ACT_ENVIRONMENT = previous;
    await first.dispose(); await second.dispose();
  }
});

it("keeps native models and cleanup isolated inside a Vue consumer bundle", async () => {
  const { View, first, second } = counter("BundledVueCounter"), Counter = asVue(View);
  const host = document.createElement("div");
  const app = createApp(() => vueElement("section", null, [
    vueElement(Counter, { model: first }), vueElement(Counter, { model: second }),
  ]));
  try {
    app.mount(host);
    const buttons = host.querySelectorAll("button");
    expect(buttons).toHaveLength(2);
    buttons[0]!.click(); await nextTick();
    expect(first.count.value).toBe(1);
    expect(second.count.value).toBe(0);
    expect(host.querySelector("button")).toBe(buttons[0]);
    expect(host.textContent).toBe("10");
    app.unmount();
    expect(host.childNodes).toHaveLength(0);
    buttons[0]!.click();
    expect(first.count.value).toBe(1);
  } finally {
    app.unmount();
    await first.dispose(); await second.dispose();
  }
});
