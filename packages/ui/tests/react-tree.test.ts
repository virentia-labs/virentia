import { f, model } from "@virentia/core/models";
import { act, createElement as r } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { expect, test, vi } from "vitest";
import { component, h } from "../lib";
import { asReact } from "../lib/react";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

test("the React host SSR boundary is the actual empty root; native view starts after hydration commit", async () => {
  const setup = vi.fn(), view = vi.fn();
  const Model = model({ data: { label: f.string("native") }, setup });
  const Native = component({ model: Model, root: "section", view(_props, self) {
    view(); return h("section", null, h("p", null, self.model.label));
  } });
  const Embedded = asReact(Native);
  const html = renderToString(r(Embedded));
  expect(html).toBe("<section></section>");
  expect(setup).not.toHaveBeenCalled(); expect(view).not.toHaveBeenCalled();
  const container = document.createElement("div"); container.innerHTML = html; document.body.append(container);
  const section = container.querySelector("section");
  let root!: ReturnType<typeof hydrateRoot>;
  try {
    await act(async () => { root = hydrateRoot(container, r(Embedded)); });
    expect(container.querySelector("section")).toBe(section);
    expect(container.textContent).toBe("native");
    expect(setup).toHaveBeenCalledTimes(1); expect(view).toHaveBeenCalledTimes(1);
  } finally { if (root) await act(async () => root.unmount()); container.remove(); }
});
