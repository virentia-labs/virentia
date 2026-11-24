import { effect, reaction, scope } from "@virentia/core";
import { f, model } from "@virentia/core/models";
import { collection } from "../../core/lib/models/collection";
import { describe, expect, vi } from "vitest";
import { it } from "./support/vitest";
import { action, component, h, ui } from "../lib";
import { mountEmbedded } from "../lib/embedded";

describe("native embedding commits", () => {
  it("uses the external root, publishes committed props and leaves sibling placement untouched", async ({ root }) => {
    const Model = model({ data: { label: f.string(), count: f.number(0) }, setup(self) {
      return { increment: action(() => { self.count.value++; }) };
    } });
    const view = vi.fn((_props, self) => h("button", { class: "native", onClick: self.model.increment }, self.model.label, self.model.count));
    const View = component({ model: Model, root: "button", view });
    const host = root.document.createElement("button");
    const sibling = root.document.createElement("i");
    root.container.append(host, sibling);
    const mounted = mountEmbedded(View, { id: "one", label: "A" }, host, { scope: root.scope, identifierPrefix: "host" });
    expect(host.textContent).toBe("A0");
    host.click();
    mounted.update({ id: "one", label: "B" });
    expect(host.textContent).toBe("B1");
    expect(root.container.children).toHaveLength(2);
    expect(root.container.firstElementChild).toBe(host);
    expect(view).toHaveBeenCalledTimes(1);
    await mounted.dispose();
    expect(root.container.firstElementChild).toBe(host);
    expect(root.container.lastElementChild).toBe(sibling);
    expect(host.childNodes).toHaveLength(0);
    expect(collection(Model, root.scope).ids).toEqual([]);
  });
  it("waits outgoing lifecycle before changing model identity on the same host", async ({ root }) => {
    let release!: () => void;
    const wait = effect(() => new Promise<void>((resolve) => { release = resolve; }));
    const Model = model({ with: [ui], data: { label: f.string() }, setup(self) {
      reaction({ on: self.unmounted, run: async () => { if (self.id === "a") await wait(); } });
    } });
    const View = component({ model: Model, root: "button", view: (_props, self) => h("button", null, self.model.label) });
    const host = root.document.createElement("button"); root.container.append(host);
    const mounted = mountEmbedded(View, { id: "a", label: "A" }, host, { scope: root.scope, identifierPrefix: "host" });
    const change = mounted.update({ id: "b", label: "B" });
    mounted.update({ id: "c", label: "C" });
    expect(host.textContent).toBe("A");
    release(); await change;
    expect(host.textContent).toBe("C");
    expect(collection(Model, root.scope).ids).toEqual(["c"]);
    await mounted.dispose();
  });
  it("rejects mismatched/occupied hosts without clearing user DOM or leaking a kept model", async ({ root }) => {
    const Model = model({});
    const View = component({ model: Model, root: "button", keep: true, view: () => h("div") });
    const host = root.document.createElement("button"); root.container.append(host);
    expect(() => mountEmbedded(View, { id: "failed" }, host, { scope: root.scope, identifierPrefix: "host" })).toThrow("stable <button>");
    expect(collection(Model, root.scope).ids).toEqual([]);
    host.textContent = "owned by someone else";
    expect(() => mountEmbedded(View, {}, host, { scope: root.scope, identifierPrefix: "host" })).toThrow("must be empty");
    expect(host.textContent).toBe("owned by someone else");
  });
  it("rejects a cross-scope ready model before detaching the outgoing display", async ({ root }) => {
    const Model = model({ data: { label: f.string("first") } });
    const View = component({ model: Model, root: "button", view: (_props, self) => h("button", null, self.model.label) });
    const host = root.document.createElement("button"); root.container.append(host);
    const mounted = mountEmbedded(View, { id: "first" }, host, { scope: root.scope, identifierPrefix: "host" });
    const wrong = collection(Model, scope()).add({ id: "wrong" });
    expect(() => mounted.update({ model: wrong } as never)).toThrow("different render scope");
    expect(host.textContent).toBe("first");
    await mounted.dispose();
  });
});
