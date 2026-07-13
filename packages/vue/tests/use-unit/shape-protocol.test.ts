// @vitest-environment happy-dom

import { event, reaction, scope, store } from "@virentia/core";
import { setActiveScope } from "@virentia/core/internal";
import { flushPromises } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defineComponent, h, isRef, type Ref } from "vue";
import { SHAPE, useModel, useUnit } from "../../lib";
import { mountWithScope, unmountAll } from "../support/mount";

beforeEach(() => {
  setActiveScope(null);
});

afterEach(() => {
  unmountAll();
  setActiveScope(null);
});

describe("useUnit (@@shape protocol)", () => {
  it("binds an opaque value through its @@shape object declaration", async () => {
    const appScope = scope();
    const changed = event<string>();
    const name = store("Ada");
    reaction({ on: changed, run: (value) => (name.value = value) });

    class Model {
      readonly name = name;
      readonly changed = changed;
      readonly [SHAPE] = { name: this.name, changed: this.changed };
      greet() {
        return "hi";
      }
    }

    let bound!: { name: Ref<string>; changed: (v: string) => Promise<void> };
    const Comp = defineComponent({
      setup() {
        bound = useUnit(new Model());
        return () => h("button", { onClick: () => bound.changed("Grace") }, bound.name.value);
      },
    });

    const wrapper = mountWithScope(appScope, Comp);
    expect(isRef(bound.name)).toBe(true);
    expect(wrapper.text()).toBe("Ada");

    await wrapper.get("button").trigger("click");
    await flushPromises();
    expect(wrapper.text()).toBe("Grace");
  });

  it("accepts the effector-style @@shape method form", () => {
    const appScope = scope();
    const count = store(7);
    const source = {
      count,
      [SHAPE]() {
        return { count: this.count };
      },
    };

    let bound!: { count: Ref<number> };
    const Comp = defineComponent({
      setup() {
        bound = useUnit(source);
        return () => null;
      },
    });

    mountWithScope(appScope, Comp);
    expect(bound.count.value).toBe(7);
  });

  it("resolves nested @@shape declarations to any depth", async () => {
    const appScope = scope();
    const tick = event<void>();
    const count = store(0);
    reaction({ on: tick, run: () => (count.value += 1) });

    const inner = { count, [SHAPE]: { count } };
    const outer = {
      [SHAPE]: {
        header: { title: store("panel") },
        counter: inner,
        tick,
      },
    };

    let bound!: {
      header: { title: Ref<string> };
      counter: { count: Ref<number> };
      tick: () => Promise<void>;
    };
    const Comp = defineComponent({
      setup() {
        bound = useUnit(outer);
        return () =>
          h(
            "button",
            { onClick: () => bound.tick() },
            `${bound.header.title.value}:${bound.counter.count.value}`,
          );
      },
    });

    const wrapper = mountWithScope(appScope, Comp);
    expect(wrapper.text()).toBe("panel:0");

    await wrapper.get("button").trigger("click");
    await flushPromises();
    expect(wrapper.text()).toBe("panel:1");
  });

  it("binds a model field that declares @@shape and hides the marker key", () => {
    const appScope = scope();
    const value = store("v");

    class SubModel {
      readonly value = value;
      readonly [SHAPE] = { value: this.value };
    }

    const model = { sub: new SubModel(), plain: store(1) };

    let bound!: { sub: { value: Ref<string> }; plain: Ref<number> };
    const Comp = defineComponent({
      setup() {
        bound = useModel(model);
        return () => null;
      },
    });

    mountWithScope(appScope, Comp);
    expect(bound.sub.value.value).toBe("v");
    expect(bound.plain.value).toBe(1);
    expect(SHAPE in (bound.sub as object)).toBe(false);
  });

  it("throws on a cyclic @@shape instead of recursing forever", () => {
    const appScope = scope();
    const cyclic: Record<PropertyKey, unknown> = { count: store(0) };
    cyclic[SHAPE] = { self: cyclic }; // the shape resolves back to its own source

    const Comp = defineComponent({
      setup() {
        useUnit(cyclic);
        return () => null;
      },
    });

    expect(() => mountWithScope(appScope, Comp)).toThrow(/cyclic/i);
  });

  it("allows a shape reused in sibling positions (diamond, not cycle)", () => {
    const appScope = scope();
    const value = store(1);
    const sub = { value, [SHAPE]: { value } };
    const root = { [SHAPE]: { a: sub, b: sub } }; // same source object in two slots

    let bound!: { a: { value: Ref<number> }; b: { value: Ref<number> } };
    const Comp = defineComponent({
      setup() {
        bound = useUnit(root);
        return () => null;
      },
    });

    mountWithScope(appScope, Comp);
    expect(bound.a.value.value).toBe(1);
    expect(bound.b.value.value).toBe(1);
  });
});
