// @vitest-environment happy-dom

import { scope, scoped, store } from "@virentia/core";
import { setActiveScope } from "@virentia/core/internal";
import { flushPromises } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defineComponent, h, nextTick } from "vue";
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
  it("keeps two components bound to one store isolated across scopes", async () => {
    const scopeA = scope();
    const scopeB = scope();
    const count = store(0);

    const Reader = defineComponent({
      setup() {
        const value = useUnit(count);
        return () => h("span", value.value);
      },
    });

    const a = mountWithScope(scopeA, Reader);
    const b = mountWithScope(scopeB, Reader);

    expect(a.text()).toBe("0");
    expect(b.text()).toBe("0");

    scoped(scopeB, () => {
      count.value = 9;
    });
    await flushPromises();
    await nextTick();

    expect(a.text()).toBe("0");
    expect(b.text()).toBe("9");
  });
});
