// @vitest-environment happy-dom

import { event, reaction, scope, store } from "@virentia/core";
import { setActiveScope } from "@virentia/core/internal";
import { flushPromises } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defineComponent, h, nextTick, ref, type Component } from "vue";
import { component, ScopeProvider, type ModelContext } from "../../lib";
import { mountHost, unmountAll } from "../support/mount";

beforeEach(() => {
  setActiveScope(null);
});

afterEach(() => {
  unmountAll();
  setActiveScope(null);
});

// The component takes `{ label }`, the model needs `{ label; uuid }`.
function createPageModel({ props }: ModelContext<{ label: string; uuid: string }>) {
  const opened = event<void>();
  const openedWith = store("");
  const tag = store(`${props.label}:${props.uuid}`);
  reaction({ on: opened, run: () => (openedWith.value = `${props.label}:${props.uuid}`) });
  reaction({ on: props, run: (next) => (tag.value = `${next.label}:${next.uuid}`) });
  return { opened, openedWith, tag };
}

const pageView: Component = defineComponent({
  props: { label: { type: String, required: true }, model: { type: Object, required: true } },
  setup(props) {
    return () =>
      h("span", `${props.label}|${(props.model as { tag: { value: string } }).tag.value}`);
  },
});

describe("component (mapProps)", () => {
  it("maps external props to model props; the view keeps external props", async () => {
    const appScope = scope();
    const Page = component({
      mapProps: (props: { label: string }) => ({ ...props, uuid: "u-1" }),
      model: createPageModel,
      view: pageView,
    });

    const wrapper = mountHost(() =>
      h(ScopeProvider, { scope: appScope }, { default: () => h(Page, { label: "home" }) }),
    );
    await flushPromises();

    // view sees external `label`; model tag carries the mapped uuid.
    expect(wrapper.text()).toBe("home|home:u-1");
  });

  it("re-runs mapProps when the external props change", async () => {
    const appScope = scope();
    const labelRef = ref("home");
    const Page = component({
      mapProps: (props: { label: string }) => ({ ...props, uuid: `u-${props.label}` }),
      model: createPageModel,
      view: pageView,
    });

    const wrapper = mountHost(() =>
      h(ScopeProvider, { scope: appScope }, { default: () => h(Page, { label: labelRef.value }) }),
    );
    await flushPromises();
    expect(wrapper.text()).toBe("home|home:u-home");

    labelRef.value = "about";
    await nextTick();
    await flushPromises();
    expect(wrapper.text()).toBe("about|about:u-about");
  });

  it("without mapProps, external and model props coincide", async () => {
    const appScope = scope();

    function createModel({ props }: ModelContext<{ label: string }>) {
      const tag = store(props.label);
      reaction({ on: props, run: (next) => (tag.value = next.label) });
      return { tag };
    }

    const view: Component = defineComponent({
      props: { model: { type: Object, required: true } },
      setup(props) {
        return () => h("span", (props.model as { tag: { value: string } }).tag.value);
      },
    });
    const C = component({ model: createModel, view });

    const wrapper = mountHost(() =>
      h(ScopeProvider, { scope: appScope }, { default: () => h(C, { label: "plain" }) }),
    );
    await flushPromises();
    expect(wrapper.text()).toBe("plain");
  });
});
