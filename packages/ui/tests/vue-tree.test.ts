import { f, model } from "@virentia/core/models";
import { createSSRApp, h as v, nextTick } from "vue";
import { renderToString } from "vue/server-renderer";
import { expect, test, vi } from "vitest";
import { component, h } from "../lib";
import { asVue } from "../lib/vue";

test("the Vue host SSR boundary is an empty native root, reused after hydration commit", async () => {
  const setup = vi.fn(), view = vi.fn();
  const Model = model({ data: { label: f.string("native") }, setup });
  const Native = component({ model: Model, root: "section", view(_props, self) {
    view(); return h("section", null, h("p", null, self.model.label));
  } });
  const Embedded = asVue(Native);
  const html = await renderToString(createSSRApp(() => v(Embedded)));
  expect(html).toBe("<section></section>");
  expect(setup).not.toHaveBeenCalled(); expect(view).not.toHaveBeenCalled();
  const container = document.createElement("div"); container.innerHTML = html; document.body.append(container);
  const section = container.querySelector("section");
  const app = createSSRApp(() => v(Embedded));
  try {
    app.mount(container); await nextTick();
    expect(container.querySelector("section")).toBe(section);
    expect(container.textContent).toBe("native");
    expect(setup).toHaveBeenCalledTimes(1); expect(view).toHaveBeenCalledTimes(1);
  } finally { app.unmount(); container.remove(); }
});
