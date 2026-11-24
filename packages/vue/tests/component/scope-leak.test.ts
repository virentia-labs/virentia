// @vitest-environment happy-dom

import { scope } from "@virentia/core";
import { getActiveScope, setActiveScope } from "@virentia/core/internal";
import { flushPromises } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { h } from "vue";
import { component, ScopeProvider } from "../../lib";
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
  it("does not leak the ambient scope after mounting or unmounting", async () => {
    const appScope = scope();
    const Counter = component({ model: createCounterModel, view: counterView() });

    const wrapper = mountHost(() =>
      h(ScopeProvider, { scope: appScope }, { default: () => h(Counter, { step: 1 }) }),
    );
    await flushPromises();

    expect(getActiveScope()).toBe(null);
    wrapper.unmount();
    await flushPromises();
    expect(getActiveScope()).toBe(null);
  });
});
