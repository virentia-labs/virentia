// @vitest-environment happy-dom

import { event, reaction, scope, scoped, store, type Store } from "@virentia/core";
import { setActiveScope } from "@virentia/core/internal";
import { flushPromises } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { h, nextTick, ref } from "vue";
import { component } from "../../lib";
import type { ComponentModel, ModelContext } from "../../lib";
import { counterView, createCounterModel } from "../support/counter-model";
import { mountHost, unmountAll } from "../support/mount";

beforeEach(() => {
  setActiveScope(null);
});

afterEach(() => {
  unmountAll();
  setActiveScope(null);
});

describe("component", () => {
  it("keeps a controlled model usable and undisposed after host unmount", async () => {
    const appScope = scope();
    const Counter = component({ model: createCounterModel, view: counterView() });
    const model = scoped(appScope, () => Counter.create({ step: 2 })) as unknown as Record<
      PropertyKey,
      unknown
    > & {
      clicked: () => Promise<void>;
      count: Store<number>;
    };

    const wrapper = mountHost(() =>
      h(Counter, {
        step: 2,
        model: model as unknown as ComponentModel<ReturnType<typeof createCounterModel>>,
      }),
    );
    await flushPromises();

    await scoped(appScope, () => model.clicked());
    await flushPromises();
    scoped(appScope, () => expect(model.count.value).toBe(2));

    wrapper.unmount();

    // NOT disposed on unmount: the external model still processes events.
    await scoped(appScope, () => model.clicked());
    await flushPromises();
    scoped(appScope, () => expect(model.count.value).toBe(4));

    (model.dispose as () => void)();
  });

  // kept: also asserts lifecycle ordering (mounted:1/unmounted:0) and prop-update reactivity (step 2->5 yields text 7), beyond the partner's dispose-after-unmount check
  it("drives a controlled model created outside Vue", async () => {
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
    const model = scoped(appScope, () => Counter.create({ step: 2 }));
    const step = ref(2);
    const wrapper = mountHost(() => h(Counter, { step: step.value, model }));

    expect(lifecycle).toEqual(["mounted:1"]);

    await scoped(appScope, () => model.clicked());
    await flushPromises();
    expect(wrapper.text()).toBe("2");

    step.value = 5;
    await nextTick();
    await flushPromises();

    await scoped(appScope, () => model.clicked());
    await flushPromises();
    expect(wrapper.text()).toBe("7");

    wrapper.unmount();

    await scoped(appScope, () => model.clicked());

    scoped(appScope, () => {
      expect(model.count.value).toBe(12);
    });
    expect(lifecycle).toEqual(["mounted:1", "unmounted:0"]);

    model.dispose();
  });
});
