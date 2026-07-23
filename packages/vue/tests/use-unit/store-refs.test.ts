// @vitest-environment happy-dom

import { event, reaction, scope, scoped, store } from "@virentia/core";
import { setActiveScope } from "@virentia/core/internal";
import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defineComponent, effectScope, h, type Ref } from "vue";
import { ScopeProvider, useUnit } from "../../lib";
import { bindUnit } from "../../lib/use-unit";
import { mountWithScope, unmountAll } from "../support/mount";
import { trackSubscriptions } from "../support/track-subscriptions";

beforeEach(() => {
  setActiveScope(null);
});

afterEach(() => {
  unmountAll();
  setActiveScope(null);
});

describe("bindUnit", () => {
  it("seeds the ref value from a write applied just before binding", () => {
    const appScope = scope();
    const count = store(0);

    scoped(appScope, () => {
      count.value = 42;
    });

    const ref0 = bindUnit(count, appScope) as Ref<number>;

    expect(ref0.value).toBe(42);
  });

  it("only updates for writes made in the bound scope", async () => {
    const scopeA = scope();
    const scopeB = scope();
    const count = store(0);

    const refA = bindUnit(count, scopeA) as Ref<number>;
    const refB = bindUnit(count, scopeB) as Ref<number>;

    scoped(scopeB, () => {
      count.value = 7;
    });
    await flushPromises();

    expect(refA.value).toBe(0);
    expect(refB.value).toBe(7);
  });

  it("updates both refs when one store is bound twice in the same scope", async () => {
    const appScope = scope();
    const count = store(0);

    const first = bindUnit(count, appScope) as Ref<number>;
    const second = bindUnit(count, appScope) as Ref<number>;

    scoped(appScope, () => {
      count.value = 3;
    });
    await flushPromises();

    expect(first.value).toBe(3);
    expect(second.value).toBe(3);
  });

  it("stays live without a Vue effect scope on the stack", () => {
    const appScope = scope();
    const count = store(1);

    // No effectScope on the stack -> getCurrentVueScope() is null -> no
    // onScopeDispose is registered, but the ref must still work and stay subscribed.
    const ref0 = bindUnit(count, appScope) as Ref<number>;

    expect(ref0.value).toBe(1);
    scoped(appScope, () => {
      count.value = 2;
    });
    expect(ref0.value).toBe(2);
  });

  it("unsubscribes when its Vue effect scope is disposed", async () => {
    const appScope = scope();
    const count = store(0);
    const { unit: tracked, count: getActive } = trackSubscriptions(count);

    const es = effectScope();
    let bound!: Ref<number>;
    es.run(() => {
      bound = bindUnit(tracked, appScope) as Ref<number>;
      // The binding is lazy: the store is subscribed on first read, not at bind.
      // The read happens inside `es.run` so the disposal hook binds to this scope.
      void bound.value;
    });

    expect(getActive()).toBe(1);

    scoped(appScope, () => {
      count.value = 5;
    });
    await flushPromises();
    expect(bound.value).toBe(5);

    es.stop();
    expect(getActive()).toBe(0);

    scoped(appScope, () => {
      count.value = 9;
    });
    await flushPromises();
    // Detached: no further updates.
    expect(bound.value).toBe(5);
  });

  it("leaves no live subscribers across repeated mount and unmount cycles", async () => {
    const appScope = scope();
    const count = store(0);
    const { unit: tracked, count: getActive } = trackSubscriptions(count);

    const Reader = defineComponent({
      setup() {
        const value = useUnit(tracked);
        return () => h("span", value.value);
      },
    });

    for (let i = 0; i < 5; i += 1) {
      const wrapper = mount(
        defineComponent({
          setup: () => () => h(ScopeProvider, { scope: appScope }, { default: () => h(Reader) }),
        }),
      );
      expect(getActive()).toBe(1);
      wrapper.unmount();
      expect(getActive()).toBe(0);
    }
  });

  it("reflects the last of several synchronous scoped writes", async () => {
    const appScope = scope();
    const count = store(0);

    const bound = bindUnit(count, appScope) as Ref<number>;

    scoped(appScope, () => {
      count.value = 1;
      count.value = 2;
      count.value = 3;
    });
    await flushPromises();

    expect(bound.value).toBe(3);
  });
});

describe("useUnit", () => {
  // kept: covers component-level useUnit for a store ref and an event callable plus cross-scope isolation (dispatch in another scope leaves the component untouched), beyond the primitive bindUnit partner
  it("reads a store and dispatches an event in the provided scope", async () => {
    const appScope = scope();
    const otherScope = scope();
    const incremented = event<number>();
    const count = store(0);

    reaction({
      on: incremented,
      run(amount) {
        count.value += amount;
      },
    });

    const Counter = defineComponent({
      setup() {
        const value = useUnit(count);
        const increment = useUnit(incremented);

        return () => h("button", { onClick: () => increment(2) }, value.value);
      },
    });

    const wrapper = mountWithScope(appScope, Counter);

    expect(wrapper.text()).toBe("0");

    await wrapper.get("button").trigger("click");
    await flushPromises();

    expect(wrapper.text()).toBe("2");

    await scoped(otherScope, () => incremented(10));
    await flushPromises();

    expect(wrapper.text()).toBe("2");
    scoped(otherScope, () => {
      expect(count.value).toBe(10);
    });
  });
});
