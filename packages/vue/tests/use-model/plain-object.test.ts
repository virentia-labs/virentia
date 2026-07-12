// @vitest-environment happy-dom

import { event, reaction, scope, store } from "@virentia/core";
import { setActiveScope } from "@virentia/core/internal";
import { flushPromises } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defineComponent, h, isRef } from "vue";
import { useModel } from "../../lib";
import { mountWithScope, unmountAll } from "../support/mount";

beforeEach(() => {
  setActiveScope(null);
});

afterEach(() => {
  unmountAll();
  setActiveScope(null);
});

describe("useModel", () => {
  it("binds stores to refs and events to callables for a plain object", async () => {
    const appScope = scope();
    const inc = event<void>();
    const count = store(0);
    reaction({
      on: inc,
      run() {
        count.value += 1;
      },
    });
    const plain = { inc, count };

    const Comp = defineComponent({
      setup() {
        const model = useModel(plain);
        expect(isRef(model.count)).toBe(true);
        return () =>
          h("button", { onClick: () => (model.inc as () => void)() }, model.count.value);
      },
    });

    const wrapper = mountWithScope(appScope, Comp);
    expect(wrapper.text()).toBe("0");

    await wrapper.get("button").trigger("click");
    await flushPromises();
    expect(wrapper.text()).toBe("1");
  });
});
