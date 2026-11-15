import { reaction, scope, serialize, store } from "@virentia/core";
import { staticModel } from "@virentia/core/models";
import { collection } from "../../core/lib/models/collection";
import { describe, expect } from "vitest";
import { it } from "./support/vitest";
import { component, h, ref, render, ui, type RefUnit } from "../lib";
import { renderToString } from "../lib/server";

describe("DOM references are model stores", () => {
  it("keeps a shared static declaration isolated per instance and publishes before mounted", async ({ root }) => {
    const log: string[] = [];
    const Model = staticModel({ with: [ui], setup(self) {
      const input = ref<HTMLInputElement>();
      reaction({ on: self.mounted, run: () => {
        expect(input.value?.isConnected).toBe(true); log.push(self.id);
      } });
      return { input };
    } });
    const View = component({ model: Model, view: (_props, self) => h("input", { ref: self.model.input, "data-id": self.id }) });
    const [a, b] = root.run(() => [Model.create({ id: "a" }), Model.create({ id: "b" })]);
    await root.render(() => [h(View, { model: a }), h(View, { model: b })]);
    expect(a.input.value).toBe(root.container.querySelector('[data-id="a"]'));
    expect(b.input.value).toBe(root.container.querySelector('[data-id="b"]'));
    expect(a.input.value).not.toBe(b.input.value);
    expect(log).toEqual(["a", "b"]);
    await root.render(() => null);
    expect([a.input.value, b.input.value]).toEqual([null, null]);
  });
  it("accepts an ordinary SID store as a transient ref and never snapshots DOM", async ({ root }) => {
    const Model = staticModel({ name: "RefSnapshot", setup() {
      return { input: store<HTMLInputElement | null>(null, undefined, { sid: "input" }) };
    } });
    const View = component({ model: Model, view: (_props, self) => h("input", { ref: self.model.input }) });
    const instance = root.run(() => Model.create({ id: "field" }));
    await root.render(() => h(View, { model: instance }));
    expect(instance.input.value).not.toBeNull();
    expect(Object.keys(serialize(root.scope)).every((sid) => !sid.endsWith("/input"))).toBe(true);
    await root.render(() => null);
    expect(instance.input.value).toBeNull();
  });
  it("lets a child's view attach the parent's bound ref without changing its owner", async ({ root }) => {
    const ParentModel = staticModel({ setup() { return { input: ref<HTMLInputElement>() }; } });
    // Pure DOM fragment: no second model or identity is introduced.
    const Child = (props: { input: RefUnit<HTMLInputElement> }) => h("input", { ref: props.input });
    const Parent = component({ model: ParentModel, view: (_props, self) => h(Child, { input: self.model.input }) });
    await root.render(() => h(Parent, { id: "parent" }));
    const parent = collection(ParentModel, root.scope).get("parent")!;
    expect(parent.input.value).toBe(root.container.querySelector("input"));
    await root.render(() => null);
    expect(parent.alive).toBe(false);
  });
  it("rejects two live elements and callback/object refs and rolls back partial DOM", () => {
    const input = ref<HTMLInputElement>();
    const container = document.createElement("div");
    const app = scope();
    expect(() => render(() => [h("input", { ref: input }), h("input", { ref: input })], container, { scope: app })).toThrow("one live DOM element");
    expect(container.childNodes).toHaveLength(0);
    expect(() => render(() => h("input", { ref: () => {} }), container, { scope: app })).toThrow("writable store");
    expect(() => render(() => h("input", { ref: { current: null } }), container, { scope: app })).toThrow("writable store");
  });
  it("keeps server refs empty and claims the existing hydrated element", async ({ root }) => {
    const Model = staticModel({ name: "HydratedRef", setup() { return { input: ref<HTMLInputElement>() }; } });
    const View = component({ model: Model, view: (_props, self) => h("input", { ref: self.model.input, value: "server" }) });
    const server = scope();
    const html = renderToString(() => h(View, { id: "field" }), { scope: server, identifierPrefix: "test" });
    expect(collection(Model, server).get("field")!.input.value).toBeNull();
    root.container.innerHTML = html;
    const existing = root.container.querySelector("input");
    await root.hydrate(() => h(View, { id: "field" }), html);
    const instance = collection(Model, root.scope).get("field")!;
    expect(instance.input.value).toBe(root.container.querySelector("input"));
    expect(instance.input.value!.value).toBe("server");
  });
});
