// @vitest-environment happy-dom

import { scope, store } from "@virentia/core";
import { setActiveScope } from "@virentia/core/internal";
import { flushPromises } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defineComponent, h, type Ref } from "vue";
import { useModel } from "../../lib";
import { mountWithScope, unmountAll } from "../support/mount";
import { trackSubscriptions } from "../support/track-subscriptions";

beforeEach(() => {
  setActiveScope(null);
});

afterEach(() => {
  unmountAll();
  setActiveScope(null);
});

describe("useModel (read granularity)", () => {
  it("never subscribes to a model store the view does not read", async () => {
    const appScope = scope();
    const title = store("panel");
    const { unit: hidden, count: getActive } = trackSubscriptions(store(0));
    const model = { title, hidden };

    const View = defineComponent({
      setup() {
        const m = useModel(model);
        return () => h("span", (m.title as Ref<string>).value);
      },
    });

    const wrapper = mountWithScope(appScope, View);
    await flushPromises();

    expect(wrapper.text()).toBe("panel");
    // The view reads only `title`, so the untouched field stays unsubscribed.
    expect(getActive()).toBe(0);

    wrapper.unmount();
  });

  it("never subscribes to an unread sub-model store", async () => {
    const appScope = scope();
    const title = store("panel");
    const { unit: hidden, count: getActive } = trackSubscriptions(store(0));
    const model = { title, sub: { count: hidden } };

    const View = defineComponent({
      setup() {
        const m = useModel(model);
        return () => h("span", (m.title as Ref<string>).value);
      },
    });

    const wrapper = mountWithScope(appScope, View);
    await flushPromises();

    expect(getActive()).toBe(0);

    wrapper.unmount();
  });
});
