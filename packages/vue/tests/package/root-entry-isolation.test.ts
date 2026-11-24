// @vitest-environment happy-dom
import { scope, scoped, store } from "@virentia/core";
import { mount } from "@vue/test-utils";
import { expect, it, vi } from "vitest";
import { defineComponent, h, nextTick } from "vue";

vi.mock("@virentia/core/models", () => {
  throw new Error("The ordinary Vue entry must not load model factories");
});
vi.mock("@sinclair/typebox", () => {
  throw new Error("Ordinary Vue stores must work without the optional schema backend");
});

it("provides isolated reactive stores without loading models or TypeBox", async () => {
  const { ScopeProvider, useUnit } = await import("../../lib");
  const first = scope(), second = scope(), count = store(0);
  const View = defineComponent({
    setup() {
      const value = useUnit(count);
      return () => h("span", String(value.value));
    },
  });
  // Pass Scope through a normal VNode: VTU's reactive props option deep-wraps it.
  const attach = (application: typeof first) => mount(defineComponent({
    setup: () => () => h(ScopeProvider, { scope: application }, { default: () => h(View) }),
  }));
  const a = attach(first), b = attach(second);
  try {
    scoped(first, () => { count.value = 2; });
    await nextTick();
    expect(a.text()).toBe("2");
    expect(b.text()).toBe("0");
  } finally {
    a.unmount();
    b.unmount();
  }
});
