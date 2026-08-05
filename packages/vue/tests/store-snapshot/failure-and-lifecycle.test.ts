// @vitest-environment happy-dom

import { effect, event, reaction, scope, scoped, setErrorReporter, store } from "@virentia/core";
import type { VirentiaFailureReport } from "@virentia/core";
import { setActiveScope } from "@virentia/core/internal";
import { flushPromises } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defineComponent, h } from "vue";
import { useUnit } from "../../lib";
import { mountWithScope, unmountAll } from "../support/mount";

beforeEach(() => {
  setActiveScope(null);
});

afterEach(() => {
  unmountAll();
  setActiveScope(null);
  setErrorReporter(null);
});

function view(read: () => unknown) {
  return defineComponent({
    setup() {
      return () => h("div", String(read()));
    },
  });
}

describe("Vue under failing rules and lifecycle churn", () => {
  it("renders a derived store and keeps a sibling reaction firing", async () => {
    const appScope = scope();
    const $n = store(0);
    const $doubled = $n.map((v) => v * 2);
    const seen: number[] = [];

    reaction({ on: $doubled, run: (v: number) => seen.push(v) });

    const Component = defineComponent({
      setup() {
        const doubled = useUnit($doubled);

        return () => h("div", String(doubled.value));
      },
    });
    const wrapper = mountWithScope(appScope, Component);

    scoped(appScope, () => {
      $n.value = 3;
    });
    await flushPromises();

    expect(wrapper.text()).toBe("6");
    expect(seen).toEqual([6]);
  });

  it("keeps rendering when an unrelated reaction throws, and reports it", async () => {
    const reports: VirentiaFailureReport[] = [];
    setErrorReporter((failure) => reports.push(failure));

    const appScope = scope();
    const $n = store(0, undefined, { name: "$n" });

    reaction({
      name: "brokenRule",
      on: $n,
      run: () => {
        throw new Error("rule is broken");
      },
    });

    const Component = defineComponent({
      setup() {
        const n = useUnit($n);

        return () => h("div", String(n.value));
      },
    });
    const wrapper = mountWithScope(appScope, Component);

    scoped(appScope, () => {
      $n.value = 5;
    });
    await flushPromises();

    expect(wrapper.text()).toBe("5");
    expect(reports.map((r) => r.unit)).toContain('reaction "brokenRule"');
  });

  it("stops updating after unmount", async () => {
    const appScope = scope();
    const $n = store(0);
    const renders: number[] = [];

    const Component = defineComponent({
      setup() {
        const n = useUnit($n);

        return () => {
          renders.push(n.value);

          return h("div", String(n.value));
        };
      },
    });
    const wrapper = mountWithScope(appScope, Component);

    scoped(appScope, () => {
      $n.value = 1;
    });
    await flushPromises();

    const before = renders.length;

    wrapper.unmount();

    scoped(appScope, () => {
      $n.value = 2;
    });
    await flushPromises();

    expect(renders.length).toBe(before);
  });

  it("keeps two scopes independent across two mounts", async () => {
    const a = scope();
    const b = scope();
    const $n = store(1);
    const $label = $n.map((v) => `v${v}`);

    const Component = defineComponent({
      setup() {
        const label = useUnit($label);

        return () => h("div", label.value);
      },
    });

    const first = mountWithScope(a, Component);
    const second = mountWithScope(b, Component);

    scoped(a, () => {
      $n.value = 7;
    });
    await flushPromises();

    expect(first.text()).toBe("v7");
    expect(second.text()).toBe("v1");
  });

  it("reflects effect pending and settles it after a rejection", async () => {
    const appScope = scope();
    const fx = effect(async () => {
      throw new Error("request failed");
    });
    const failures: unknown[] = [];

    reaction({ on: fx.failData, run: (error) => failures.push(error) });

    const Component = defineComponent({
      setup() {
        const pending = useUnit(fx.pending);

        return () => h("div", pending.value ? "loading" : "idle");
      },
    });
    const wrapper = mountWithScope(appScope, Component);

    await scoped(appScope, () => fx(undefined as never)).catch(() => undefined);
    await flushPromises();

    expect(wrapper.text()).toBe("idle");
    expect(failures).toHaveLength(1);
  });

  it("carries an event-driven update into the template", async () => {
    const appScope = scope();
    const submit = event<string>();
    const $query = store("");

    reaction({ on: submit, run: (value: string) => void ($query.value = value) });

    const Component = defineComponent({
      setup() {
        const query = useUnit($query);

        return () => h("div", query.value);
      },
    });
    const wrapper = mountWithScope(appScope, Component);

    scoped(appScope, () => submit("hello"));
    await flushPromises();

    expect(wrapper.text()).toBe("hello");
  });

  it("does not lose the last value under a burst of updates", async () => {
    const appScope = scope();
    const $n = store(0);

    const Component = defineComponent({
      setup() {
        const n = useUnit($n);

        return () => h("div", String(n.value));
      },
    });
    const wrapper = mountWithScope(appScope, Component);

    scoped(appScope, () => {
      for (let i = 1; i <= 50; i += 1) $n.value = i;
    });
    await flushPromises();

    expect(wrapper.text()).toBe("50");
  });
});
