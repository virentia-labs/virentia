// @vitest-environment happy-dom

import { scope } from "@virentia/core";
import { setActiveScope } from "@virentia/core/internal";
import { flushPromises } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defineComponent, h, isRef, type Component } from "vue";
import { component, ScopeProvider } from "../../lib";
import { createCounterModel } from "../support/counter-model";
import { mountHost, unmountAll } from "../support/mount";

beforeEach(() => {
  setActiveScope(null);
});

afterEach(() => {
  unmountAll();
  setActiveScope(null);
});

describe("component", () => {
  it("forwards non-model attrs while injecting the reactive model", async () => {
    const appScope = scope();
    let seen: Record<string, unknown> | undefined;

    const view: Component = defineComponent({
      props: { model: { type: Object, required: true } },
      inheritAttrs: false,
      setup(props, { attrs }) {
        seen = { ...attrs, model: props.model };
        return () => h("div", `${(attrs as { step: number }).step}:${(attrs as { extra: string }).extra}`);
      },
    });
    const Widget = component({ model: createCounterModel, view });

    const wrapper = mountHost(() =>
      h(ScopeProvider, { scope: appScope }, { default: () => h(Widget, { step: 2, extra: "x" }) }),
    );
    await flushPromises();

    expect(seen).toBeTruthy();
    expect(seen!.step).toBe(2);
    expect(seen!.extra).toBe("x");
    expect(seen!.model).toBeTruthy();
    expect(isRef((seen!.model as { count: unknown }).count)).toBe(true);
    expect(wrapper.text()).toBe("2:x");
  });
});
