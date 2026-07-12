// @vitest-environment happy-dom

import { effect, event, reaction, scope, scoped, store } from "@virentia/core";
import { setActiveScope } from "@virentia/core/internal";
import { flushPromises } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bindUnit } from "../../lib/use-unit";
import { unmountAll } from "../support/mount";

beforeEach(() => {
  setActiveScope(null);
});

afterEach(() => {
  unmountAll();
  setActiveScope(null);
});

describe("bindUnit callables", () => {
  it("dispatches the event inside the bound scope on every invocation", async () => {
    const scopeA = scope();
    const scopeB = scope();
    const inc = event<void>();
    const count = store(0);

    reaction({
      on: inc,
      run() {
        count.value += 1;
      },
    });

    const boundToA = bindUnit(inc, scopeA) as () => Promise<void>;

    // Invoke while an unrelated scope is ambient on the stack.
    await scoped(scopeB, () => boundToA());
    await flushPromises();

    scoped(scopeA, () => expect(count.value).toBe(1));
    scoped(scopeB, () => expect(count.value).toBe(0));
  });

  it("resolves an effect to its Done value in the bound scope", async () => {
    const appScope = scope();
    const loadFx = effect(async (id: number) => `#${id}`);

    const call = bindUnit(loadFx, appScope) as (id: number) => Promise<string>;

    await expect(call(7)).resolves.toBe("#7");
  });

  it("propagates an effect rejection through the bound callable", async () => {
    const appScope = scope();
    const boomFx = effect(async () => {
      throw new Error("nope");
    });

    const call = bindUnit(boomFx, appScope) as () => Promise<void>;

    await expect(call()).rejects.toThrow("nope");
  });

  it("returns a thenable Promise for a bound void event", async () => {
    const appScope = scope();
    const ping = event<void>();

    const call = bindUnit(ping, appScope) as () => Promise<void>;
    const result = call();

    expect(typeof result.then).toBe("function");
    await expect(result).resolves.toBeUndefined();
  });
});
