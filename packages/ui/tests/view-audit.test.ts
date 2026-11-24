import { scope, store } from "@virentia/core";
import { f, staticModel } from "@virentia/core/models";
import { describe, expect } from "vitest";
import { it } from "./support/vitest";
import { component, createContext, Fragment, h, Portal } from "../lib";
import { renderToString } from "../lib/server";

describe("fragment DOM boundaries", () => {
  it("isolates arrays, empty slots and external portals from structural replacement", async ({ root }) => {
    const Model = staticModel({ data: { shown: f.boolean(true) } });
    const target = root.document.createElement("aside");
    root.document.body.append(target);
    const View = component({ model: Model, view(_props, self) {
      function details() { return self.model.shown.value ? [null, h("i", null, "detail")] : []; }
      return [h("b", null, "first"), details, h(Portal, { mount: target }, h("em", null, "portal")), h("b", null, "last")];
    } });
    const instance = root.run(() => Model.create({}));
    await root.render(() => h(View, { model: instance }));
    const [first, last] = root.container.querySelectorAll("b");
    const portal = target.querySelector("em");
    instance.shown.value = false;
    expect(root.container.textContent).toBe("firstlast");
    expect([...root.container.querySelectorAll("b")]).toEqual([first, last]);
    expect(target.querySelector("em")).toBe(portal);
    await root.render(() => null);
    expect(target.childNodes).toHaveLength(0);
  });
  it("hydrates nested arrays using the same range boundaries", async ({ root }) => {
    const value = store("text");
    const view = () => [[], ["a", null, h(Fragment, null, [value, false])], h("span", null, "tail")];
    const html = renderToString(view, { scope: scope(), identifierPrefix: "test" });
    await root.hydrate(view, html);
    const span = root.container.querySelector("span");
    root.run(() => { value.value = "changed"; });
    expect(root.container.textContent).toBe("achangedtail");
    expect(root.container.querySelector("span")).toBe(span);
  });
  it("keeps the consumer DOM when a context unit changes", async ({ root }) => {
    const Theme = createContext("light");
    const theme = store("dark");
    const Model = staticModel({});
    const Consumer = component({ model: Model, view: (_props, self) => h("input", { title: self.context(Theme), defaultValue: "initial" }) });
    await root.render(() => h(Theme.Provider, { value: theme }, h(Consumer)));
    const input = root.container.querySelector("input")!;
    input.value = "draft";
    root.run(() => { theme.value = "light"; });
    expect(root.container.querySelector("input")).toBe(input);
    expect(input.title).toBe("light");
    expect(input.value).toBe("draft");
  });
});
