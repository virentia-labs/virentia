// @vitest-environment happy-dom

import { scope, scoped, store } from "@virentia/core";
import { setActiveScope } from "@virentia/core/internal";
import { flushPromises } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isRef, type Ref } from "vue";
import { component } from "../../lib";
import { buildReactiveModel } from "../../lib/use-model";
import { counterView, createCounterModel } from "../support/counter-model";
import { disposeSymbol } from "../support/dispose-symbol";
import { unmountAll } from "../support/mount";

beforeEach(() => {
  setActiveScope(null);
});

afterEach(() => {
  unmountAll();
  setActiveScope(null);
});

describe("buildReactiveModel", () => {
  it("skips dispose and non-enumerable keys while binding enumerable stores to refs", () => {
    const appScope = scope();
    const model: Record<PropertyKey, unknown> = { value: store(7) };
    Object.defineProperty(model, "dispose", {
      value: () => {},
      enumerable: true,
      configurable: true,
    });
    Object.defineProperty(model, "hidden", {
      value: store(1),
      enumerable: false,
      configurable: true,
    });

    const reactiveModel = buildReactiveModel(model, appScope) as Record<PropertyKey, unknown>;

    expect("dispose" in reactiveModel).toBe(false);
    expect("hidden" in reactiveModel).toBe(false);
    expect(isRef(reactiveModel.value)).toBe(true);
    expect((reactiveModel.value as Ref<number>).value).toBe(7);
  });

  it("skips a Symbol.dispose key", () => {
    const appScope = scope();
    const model: Record<PropertyKey, unknown> = { count: store(0) };
    Object.defineProperty(model, disposeSymbol, {
      value: () => {},
      enumerable: true,
      configurable: true,
    });

    const reactiveModel = buildReactiveModel(model, appScope) as Record<PropertyKey, unknown>;

    expect(disposeSymbol in reactiveModel).toBe(false);
    expect(isRef(reactiveModel.count)).toBe(true);
  });

  it("unwraps units nested two levels deep into live refs", async () => {
    const appScope = scope();
    const flag = store(false);
    const model = { group: { inner: { flag } } };

    const reactiveModel = buildReactiveModel(model, appScope) as {
      group: { inner: { flag: Ref<boolean> } };
    };

    expect(isRef(reactiveModel.group.inner.flag)).toBe(true);
    expect(reactiveModel.group.inner.flag.value).toBe(false);

    scoped(appScope, () => {
      flag.value = true;
    });
    await flushPromises();
    expect(reactiveModel.group.inner.flag.value).toBe(true);
  });

  it("carries an enumerable symbol-keyed store field into the model", () => {
    const appScope = scope();
    const sym = Symbol("field");
    const s = store(5);
    const model = { [sym]: s };

    const reactiveModel = buildReactiveModel(model, appScope) as Record<symbol, Ref<number>>;

    expect(isRef(reactiveModel[sym])).toBe(true);
    expect(reactiveModel[sym].value).toBe(5);
  });

  it("passes a ComponentModel sibling through while recursing a plain object", () => {
    const appScope = scope();
    const Counter = component({ model: createCounterModel, view: counterView() });
    const child = scoped(appScope, () => Counter.create({ step: 1 }));

    const parent = { plain: { s: store(1) }, child };
    const reactiveModel = buildReactiveModel(parent, appScope) as {
      plain: { s: Ref<number> };
      child: typeof child;
    };

    // Plain object recursed -> store becomes a ref.
    expect(isRef(reactiveModel.plain.s)).toBe(true);
    expect(reactiveModel.plain.s.value).toBe(1);

    // ComponentModel passed through unchanged (same reference, raw units).
    expect(reactiveModel.child).toBe(child);
    // The child's units stay raw: `.count` is still the store (has `.subscribe`),
    // not rebound to a Vue ref. Reading `.subscribe` does not read store state.
    expect(typeof (reactiveModel.child as { count: { subscribe?: unknown } }).count.subscribe).toBe(
      "function",
    );

    child.dispose();
  });
});
