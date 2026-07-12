// @vitest-environment happy-dom

import { scope } from "@virentia/core";
import { setActiveScope } from "@virentia/core/internal";
import { flushPromises } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defineComponent, h } from "vue";
import { component } from "../../lib";
import type { ComponentModel } from "../../lib";
import { counterView, createCounterModel } from "../support/counter-model";
import { mountWithScope, unmountAll } from "../support/mount";

beforeEach(() => {
  setActiveScope(null);
});

afterEach(() => {
  unmountAll();
  setActiveScope(null);
});

describe("component", () => {
  it("passes a child ComponentModel through a parent model unchanged", async () => {
    const appScope = scope();
    const Counter = component({ model: createCounterModel, view: counterView() });
    const Parent = component({
      model() {
        const counter = Counter.create({ step: 2 });
        return { counter };
      },
      view: defineComponent({
        props: { model: { type: Object, required: true } },
        setup(props) {
          return () =>
            h(Counter, {
              step: 2,
              model: (props.model as { counter: unknown }).counter as ComponentModel<
                ReturnType<typeof createCounterModel>
              >,
            });
        },
      }),
    });

    const wrapper = mountWithScope(appScope, Parent);
    await wrapper.get("button").trigger("click");
    await flushPromises();
    expect(wrapper.text()).toBe("2");
  });
});
