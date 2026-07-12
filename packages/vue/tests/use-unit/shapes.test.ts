// @vitest-environment happy-dom

import { event, reaction, scope, scoped, store } from "@virentia/core";
import { setActiveScope } from "@virentia/core/internal";
import { flushPromises } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defineComponent, h, isRef, type Ref } from "vue";
import { useUnit } from "../../lib";
import { mountWithScope, unmountAll } from "../support/mount";

beforeEach(() => {
  setActiveScope(null);
});

afterEach(() => {
  unmountAll();
  setActiveScope(null);
});

describe("useUnit", () => {
  it("preserves positional order for a mixed tuple of store and event units", async () => {
    const appScope = scope();
    const first = store("a");
    const go = event<string>();
    const third = store(1);
    reaction({
      on: go,
      run(v) {
        first.value = v;
      },
    });

    let bound!: readonly unknown[];
    const Comp = defineComponent({
      setup() {
        bound = useUnit([first, go, third] as const);
        return () => null;
      },
    });
    mountWithScope(appScope, Comp);

    // Positions: [0] store ref, [1] event callable, [2] store ref.
    expect(isRef(bound[0])).toBe(true);
    expect(typeof bound[1]).toBe("function");
    expect(isRef(bound[2])).toBe(true);
    expect((bound[0] as Ref<string>).value).toBe("a");
    expect((bound[2] as Ref<number>).value).toBe(1);

    await (bound[1] as (v: string) => Promise<void>)("z");
    await flushPromises();
    expect((bound[0] as Ref<string>).value).toBe("z");
  });

  // kept: also covers record-shape binding ({ changed, name }) into refs and callables, which the tuple-only partner doesn't
  it("binds tuple and record shapes into refs and callables", async () => {
    const appScope = scope();
    const changed = event<string>();
    const name = store("Ada");
    const age = store(36);

    reaction({
      on: changed,
      run(value) {
        name.value = value;
      },
    });

    const Profile = defineComponent({
      setup() {
        const [currentName, currentAge] = useUnit([name, age] as const);
        const units = useUnit({ changed, name });

        return () =>
          h(
            "button",
            { onClick: () => units.changed("Grace") },
            `${currentName.value}:${units.name.value}:${currentAge.value}`,
          );
      },
    });

    const wrapper = mountWithScope(appScope, Profile);

    expect(wrapper.text()).toBe("Ada:Ada:36");

    await wrapper.get("button").trigger("click");
    await flushPromises();

    expect(wrapper.text()).toBe("Grace:Grace:36");
  });
});
