// @vitest-environment happy-dom

import { scope } from "@virentia/core";
import { setActiveScope } from "@virentia/core/internal";
import { mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defineComponent, h } from "vue";
import { provideScope, ScopeProvider, useProvidedScope } from "../../lib";
import { useOptionalProvidedScope } from "../../lib/scope";
import { mountHost, unmountAll } from "../support/mount";

beforeEach(() => {
  setActiveScope(null);
});

afterEach(() => {
  unmountAll();
  setActiveScope(null);
});

describe("scope providers", () => {
  it("satisfies useProvidedScope when provideScope is called directly", () => {
    const appScope = scope();
    let received: unknown;

    const Child = defineComponent({
      setup() {
        received = useProvidedScope();
        return () => null;
      },
    });
    const Parent = defineComponent({
      setup() {
        provideScope(appScope);
        return () => h(Child);
      },
    });

    mountHost(() => h(Parent));
    expect(received).toBe(appScope);
  });

  it("returns null or the provided scope from useOptionalProvidedScope", () => {
    const appScope = scope();
    let withoutProvider: unknown = "sentinel";
    let withProvider: unknown = "sentinel";

    const A = defineComponent({
      setup() {
        withoutProvider = useOptionalProvidedScope();
        return () => null;
      },
    });
    const B = defineComponent({
      setup() {
        withProvider = useOptionalProvidedScope();
        return () => null;
      },
    });

    mountHost(() => h(A));
    expect(withoutProvider).toBe(null);

    mountHost(() => h(ScopeProvider, { scope: appScope }, { default: () => h(B) }));
    expect(withProvider).toBe(appScope);
  });

  it("throws from useProvidedScope when no scope is provided", () => {
    const Reader = defineComponent({
      setup() {
        useProvidedScope();
        return () => null;
      },
    });

    expect(() => mount(Reader)).toThrow("[useProvidedScope] Scope is not provided");
  });

  it("renders the ScopeProvider default slot", () => {
    const appScope = scope();
    const wrapper = mountHost(() =>
      h(ScopeProvider, { scope: appScope }, { default: () => h("div", "hi") }),
    );
    expect(wrapper.text()).toBe("hi");
  });
});
