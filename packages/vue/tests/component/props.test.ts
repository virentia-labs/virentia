// @vitest-environment happy-dom

import { event, reaction, scope, store } from "@virentia/core";
import { setActiveScope } from "@virentia/core/internal";
import { flushPromises } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defineComponent, h, nextTick, ref, type Component } from "vue";
import { component, ScopeProvider } from "../../lib";
import type { ModelContext } from "../../lib";
import { mountHost, unmountAll } from "../support/mount";

beforeEach(() => {
  setActiveScope(null);
});

afterEach(() => {
  unmountAll();
  setActiveScope(null);
});

describe("component", () => {
  it("rewrites the whole props object when a nested prop changes", async () => {
    const appScope = scope();
    const filterRef = ref<{ q: string }>({ q: "a" });

    function model(context: ModelContext<{ filter: { q: string } }>) {
      const q = store(context.props.filter.q);
      reaction({
        on: context.props,
        run(next) {
          q.value = next.filter.q;
        },
      });
      return { q, clicked: event<void>(), count: store(0) };
    }

    const view: Component = defineComponent({
      props: { model: { type: Object, required: true } },
      setup(props) {
        return () => h("span", (props.model as { q: { value: string } }).q.value);
      },
    });
    const Widget = component({ model, view });

    const wrapper = mountHost(() =>
      h(
        ScopeProvider,
        { scope: appScope },
        { default: () => h(Widget, { filter: filterRef.value }) },
      ),
    );
    await flushPromises();
    expect(wrapper.text()).toBe("a");

    filterRef.value = { q: "b" };
    await nextTick();
    await flushPromises();
    expect(wrapper.text()).toBe("b");
  });
});
