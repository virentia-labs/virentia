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
  // SUSPECTED BUG: onMounted/onUnmounted fire lifecycle events fire-and-forget
  // (`void instance.mounted()`) inside `scoped(scope, () => …)`. Because that
  // callback is non-thenable, `scoped` restores the ambient synchronously, but
  // the event's async reaction drain re-installs `scope` as the global ambient
  // and never restores it. After any Virentia component mounts, getActiveScope()
  // stays non-null, silently breaking scope isolation (and component.create()'s
  // "no surrounding scope" guard). Correct behavior: no ambient scope should
  // survive a mount. Marked `.fails` because the code currently leaks.
  it.fails("does not leak the ambient scope after a component mounts (suspected bug)", async () => {
    const appScope = scope();
    const Counter = component({ model: createCounterModel, view: counterView() });

    const wrapper = mountHost(() =>
      h(ScopeProvider, { scope: appScope }, { default: () => h(Counter, { step: 1 }) }),
    );
    await flushPromises();

    expect(getActiveScope()).toBe(null);
    wrapper.unmount();
  });
});
