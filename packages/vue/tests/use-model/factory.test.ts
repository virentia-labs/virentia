// @vitest-environment happy-dom

import { reaction, scope, store } from "@virentia/core";
import { setActiveScope } from "@virentia/core/internal";
import { flushPromises } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defineComponent, h, nextTick, ref } from "vue";
import { useModel } from "../../lib";
import type { ModelContext } from "../../lib";
import { mountWithScope, unmountAll } from "../support/mount";

beforeEach(() => {
  setActiveScope(null);
});

afterEach(() => {
  unmountAll();
  setActiveScope(null);
});

describe("useModel", () => {
  it("reflects prop-ref changes into the factory model", async () => {
    const appScope = scope();
    const stepRef = ref(2);

    function factory(context: ModelContext<{ step: number }>) {
      const view = store(context.props.step);
      reaction({
        on: context.props,
        run(next) {
          view.value = next.step;
        },
      });
      return { view };
    }

    const Comp = defineComponent({
      setup() {
        const model = useModel(factory, () => ({ step: stepRef.value }));
        return () => h("span", model.view.value);
      },
    });

    const wrapper = mountWithScope(appScope, Comp);
    expect(wrapper.text()).toBe("2");

    stepRef.value = 5;
    await nextTick();
    await flushPromises();
    expect(wrapper.text()).toBe("5");
  });
});
