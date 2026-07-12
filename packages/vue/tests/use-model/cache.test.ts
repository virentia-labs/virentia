// @vitest-environment happy-dom

import { event, reaction, scope, store } from "@virentia/core";
import { setActiveScope } from "@virentia/core/internal";
import { flushPromises } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defineComponent, h, nextTick, ref } from "vue";
import { component, createModelCache, ScopeProvider, useModel } from "../../lib";
import { counterView } from "../support/counter-model";
import { mountHost, unmountAll } from "../support/mount";

beforeEach(() => {
  setActiveScope(null);
});

afterEach(() => {
  unmountAll();
  setActiveScope(null);
});

describe("useModel", () => {
  it("keeps a cached model alive across unmount and remount", async () => {
    const appScope = scope();
    let created = 0;

    function factory() {
      created += 1;
      const inc = event<void>();
      const count = store(0);
      reaction({
        on: inc,
        run() {
          count.value += 1;
        },
      });
      return { inc, count };
    }

    const cache = createModelCache<string, object, ReturnType<typeof factory>>();

    const Comp = defineComponent({
      setup() {
        const model = useModel(factory, () => ({}), { cache, key: "k" });
        return () =>
          h("button", { onClick: () => (model.inc as () => void)() }, model.count.value);
      },
    });

    const show = ref(true);
    const wrapper = mountHost(() =>
      h(
        ScopeProvider,
        { scope: appScope },
        { default: () => (show.value ? h(Comp) : null) },
      ),
    );

    await wrapper.get("button").trigger("click");
    await flushPromises();
    expect(wrapper.text()).toBe("1");
    expect(created).toBe(1);

    show.value = false;
    await nextTick();
    expect(cache.has("k", appScope)).toBe(true);

    show.value = true;
    await nextTick();
    expect(wrapper.text()).toBe("1");
    expect(created).toBe(1);

    cache.delete("k", appScope);
  });
});

describe("component with a model cache", () => {
  // TODO(phase-2 dedup): overlaps "keeps a cached model alive across unmount and remount"
  it("keeps cached models alive across unmounts until the cache deletes them", async () => {
    const appScope = scope();
    let created = 0;

    function createCachedModel() {
      created += 1;
      const clicked = event<void>();
      const count = store(0);

      reaction({
        on: clicked,
        run() {
          count.value += 1;
        },
      });

      return { clicked, count };
    }

    const cache = createModelCache<string, { id: string }, ReturnType<typeof createCachedModel>>();
    const CachedCounter = component({
      cache,
      key: (props: { id: string }) => props.id,
      model: createCachedModel,
      view: counterView(),
    });

    const show = ref(true);
    const wrapper = mountHost(() =>
      h(
        ScopeProvider,
        { scope: appScope },
        { default: () => (show.value ? h(CachedCounter, { id: "chat:1" }) : null) },
      ),
    );

    await wrapper.get("button").trigger("click");
    await flushPromises();

    expect(wrapper.text()).toBe("1");

    show.value = false;
    await nextTick();

    expect(cache.has("chat:1", appScope)).toBe(true);

    show.value = true;
    await nextTick();

    expect(wrapper.text()).toBe("1");
    expect(created).toBe(1);

    show.value = false;
    await nextTick();
    cache.delete("chat:1", appScope);
    show.value = true;
    await nextTick();

    expect(created).toBe(2);
    expect(wrapper.text()).toBe("0");
  });
});
