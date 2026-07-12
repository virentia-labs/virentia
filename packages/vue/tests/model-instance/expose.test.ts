// @vitest-environment happy-dom

import { scope, scoped, type Store } from "@virentia/core";
import { setActiveScope } from "@virentia/core/internal";
import { flushPromises } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { component } from "../../lib";
import type { ComponentModel } from "../../lib";
import {
  createModelInstance,
  exposeModelInstance,
  readExposedModelInstance,
} from "../../lib/use-model";
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

describe("exposeModelInstance", () => {
  it("installs the instance symbol without overwriting a pre-existing dispose", () => {
    const appScope = scope();
    const instance = scoped(appScope, () =>
      createModelInstance(createCounterModel, { step: 1 }, appScope, undefined),
    );
    const model = instance.model as Record<PropertyKey, unknown>;
    const originalDispose = () => {};
    Object.defineProperty(model, "dispose", {
      value: originalDispose,
      configurable: true,
      enumerable: true,
    });

    exposeModelInstance(instance);

    expect(model.dispose).toBe(originalDispose);
    expect(readExposedModelInstance(instance.model as ComponentModel<typeof instance.model>)).toBe(
      instance,
    );

    instance.dispose();
  });

  it("exposes instance, dispose, and Symbol.dispose that tear down the model", async () => {
    const appScope = scope();
    const Counter = component({ model: createCounterModel, view: counterView() });
    const model = scoped(appScope, () => Counter.create({ step: 2 }));

    expect(readExposedModelInstance(model)).toBeTruthy();
    expect(typeof model.dispose).toBe("function");
    expect(typeof (model as unknown as Record<PropertyKey, unknown>)[disposeSymbol]).toBe(
      "function",
    );

    await scoped(appScope, () => (model as { clicked: () => Promise<void> }).clicked());
    await flushPromises();
    scoped(appScope, () => expect((model as { count: Store<number> }).count.value).toBe(2));

    model.dispose();

    // Reactions were torn down: dispatching no longer mutates the store.
    await scoped(appScope, () => (model as { clicked: () => Promise<void> }).clicked());
    await flushPromises();
    scoped(appScope, () => expect((model as { count: Store<number> }).count.value).toBe(2));
  });

  it("tears the model down through Symbol.dispose", async () => {
    const appScope = scope();
    const Counter = component({ model: createCounterModel, view: counterView() });
    const model = scoped(appScope, () => Counter.create({ step: 3 })) as unknown as Record<
      PropertyKey,
      unknown
    > & {
      clicked: () => Promise<void>;
      count: Store<number>;
    };

    await scoped(appScope, () => model.clicked());
    await flushPromises();
    scoped(appScope, () => expect(model.count.value).toBe(3));

    (model[disposeSymbol] as () => void)();

    await scoped(appScope, () => model.clicked());
    await flushPromises();
    scoped(appScope, () => expect(model.count.value).toBe(3));
  });
});
