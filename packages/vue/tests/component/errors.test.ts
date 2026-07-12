// @vitest-environment happy-dom

import { scope } from "@virentia/core";
import { setActiveScope } from "@virentia/core/internal";
import { mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defineComponent, h } from "vue";
import { component, ScopeProvider } from "../../lib";
import type { ComponentModel } from "../../lib";
import { counterView, createCounterModel } from "../support/counter-model";
import { unmountAll } from "../support/mount";

beforeEach(() => {
  setActiveScope(null);
});

afterEach(() => {
  unmountAll();
  setActiveScope(null);
});

describe("component", () => {
  it("throws when a bare object is passed as the model prop", () => {
    const appScope = scope();
    const Counter = component({ model: createCounterModel, view: counterView() });

    expect(() =>
      mount(
        defineComponent({
          setup: () => () =>
            h(
              ScopeProvider,
              { scope: appScope },
              {
                default: () =>
                  h(Counter, {
                    step: 1,
                    model: { not: "real" } as unknown as ComponentModel<
                      ReturnType<typeof createCounterModel>
                    >,
                  }),
              },
            ),
        }),
      ),
    ).toThrow("[component] The model prop must be created with component.create().");
  });

  it("throws when uncontrolled and no scope is provided", () => {
    const Counter = component({ model: createCounterModel, view: counterView() });

    expect(() =>
      mount(
        defineComponent({
          setup: () => () => h(Counter, { step: 1 }),
        }),
      ),
    ).toThrow("[useProvidedScope] Scope is not provided");
  });

  it("throws from create() outside a surrounding virentia scope", () => {
    const Counter = component({ model: createCounterModel, view: counterView() });

    expect(() => Counter.create({ step: 1 })).toThrow(
      "[component.create] Parent component context is required.",
    );
  });
});
