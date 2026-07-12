// @vitest-environment happy-dom

import { event, reaction, scope, scoped, store } from "@virentia/core";
import { setActiveScope } from "@virentia/core/internal";
import { flushPromises } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { h, nextTick, ref } from "vue";
import { component, ScopeProvider } from "../../lib";
import type { ModelContext } from "../../lib";
import { readExposedModelInstance } from "../../lib/use-model";
import { counterView, createCounterModel } from "../support/counter-model";
import { mountHost, mountWithScope, unmountAll } from "../support/mount";

beforeEach(() => {
  setActiveScope(null);
});

afterEach(() => {
  unmountAll();
  setActiveScope(null);
});

describe("component", () => {
  it("clamps the mounts counter at zero on unmount", async () => {
    const appScope = scope();
    const Counter = component({ model: createCounterModel, view: counterView() });
    const model = scoped(appScope, () => Counter.create({ step: 1 }));
    const instance = readExposedModelInstance(model)!;

    const wrapper = mountHost(() => h(Counter, { step: 1, model }));
    await flushPromises();
    scoped(appScope, () => expect(instance.mounts.value).toBe(1));

    // Force the counter to 0 so unmount's Math.max clamp is exercised.
    scoped(appScope, () => {
      instance.mounts.value = 0;
    });

    wrapper.unmount();
    scoped(appScope, () => expect(instance.mounts.value).toBe(0));

    model.dispose();
  });

  it("emits ordered lifecycle events with a live mounts counter", async () => {
    const appScope = scope();
    const lifecycle: string[] = [];

    function model(context: ModelContext<{ step: number }>) {
      reaction({
        on: context.mounted,
        run() {
          lifecycle.push(`mounted:${context.mounts.value}`);
        },
      });
      reaction({
        on: context.unmounted,
        run() {
          lifecycle.push(`unmounted:${context.mounts.value}`);
        },
      });
      return { count: store(0), clicked: event<void>() };
    }

    const Counter = component({ model, view: counterView() });
    const wrapper = mountWithScope(appScope, Counter, { step: 1 });
    await flushPromises();
    expect(lifecycle).toEqual(["mounted:1"]);

    wrapper.unmount();
    expect(lifecycle).toEqual(["mounted:1", "unmounted:0"]);
  });

  // kept: also asserts prop-update reactivity (step 2->3 yields text 5) and click counting alongside the lifecycle events the partner covers
  it("runs a mounted model through prop updates and lifecycle events", async () => {
    const appScope = scope();
    const lifecycle: string[] = [];

    function createCounterModel(context: ModelContext<{ step: number }>) {
      const clicked = event<void>();
      const count = store(0);

      reaction({
        on: clicked,
        run() {
          count.value += context.props.step;
        },
      });

      reaction({
        on: context.mounted,
        run() {
          lifecycle.push(`mounted:${context.mounts.value}`);
        },
      });

      reaction({
        on: context.unmounted,
        run() {
          lifecycle.push(`unmounted:${context.mounts.value}`);
        },
      });

      return { clicked, count };
    }

    const Counter = component({
      model: createCounterModel,
      view: counterView(),
    });

    const step = ref(2);
    const wrapper = mountHost(() =>
      h(ScopeProvider, { scope: appScope }, { default: () => h(Counter, { step: step.value }) }),
    );

    expect(lifecycle).toEqual(["mounted:1"]);

    await wrapper.get("button").trigger("click");
    await flushPromises();

    expect(wrapper.text()).toBe("2");

    step.value = 3;
    await nextTick();
    await flushPromises();

    await wrapper.get("button").trigger("click");
    await flushPromises();

    expect(wrapper.text()).toBe("5");

    wrapper.unmount();

    expect(lifecycle).toEqual(["mounted:1", "unmounted:0"]);
  });
});
