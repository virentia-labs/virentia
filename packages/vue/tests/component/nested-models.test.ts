// @vitest-environment happy-dom

import { event, reaction, scope, store } from "@virentia/core";
import { setActiveScope } from "@virentia/core/internal";
import { flushPromises } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defineComponent, h } from "vue";
import { component } from "../../lib";
import type { ComponentModel, ModelContext } from "../../lib";
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

  // TODO(phase-2 dedup): overlaps "passes a child ComponentModel through a parent model unchanged"
  it("renders a child model passed through a parent model", async () => {
    const appScope = scope();

    function createCounterModel(context: ModelContext<{ step: number }>) {
      const clicked = event<void>();
      const count = store(0);

      reaction({
        on: clicked,
        run() {
          count.value += context.props.step;
        },
      });

      return { clicked, count };
    }

    const Counter = component({
      model: createCounterModel,
      view: counterView(),
    });
    const Parent = component({
      model() {
        const counter = Counter.create({ step: 1 });

        return { counter };
      },
      view: defineComponent({
        props: { model: { type: Object, required: true } },
        setup(props) {
          return () => h(Counter, { step: 2, model: props.model.counter });
        },
      }),
    });

    const wrapper = mountWithScope(appScope, Parent);

    await wrapper.get("button").trigger("click");
    await flushPromises();

    expect(wrapper.text()).toBe("2");
  });
});
