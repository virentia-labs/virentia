// @vitest-environment happy-dom

import { scope, scoped, store, type EventCallable } from "@virentia/core";
import { setActiveScope } from "@virentia/core/internal";
import { afterEach, describe, expect, it, vi } from "vitest";
import { action, createElement as h, render } from "../lib";
import { onUnmount } from "../lib/runtime";

afterEach(() => {
  setActiveScope(null);
});

describe("component actions", () => {
  it("turns a DOM event into a scoped reaction without rerunning the component", () => {
    const container = document.createElement("div");
    const count = store(0);
    let setups = 0;
    let unmounts = 0;

    function Counter() {
      setups++;
      const increment = action(() => {
        count.value++;
      });
      onUnmount(() => unmounts++);
      return h("button", { onClick: increment }, () => count.value);
    }

    const dispose = render(() => h(Counter), container);
    const button = container.querySelector("button")!;
    button.click();
    button.click();

    expect(button.textContent).toBe("2");
    expect(container.querySelector("button")).toBe(button);
    expect(setups).toBe(1);
    dispose();
    dispose();
    expect(unmounts).toBe(1);
  });

  it("preserves payload typing, waits for the reaction, and stops with its owner", async () => {
    const container = document.createElement("div");
    const appScope = scope();
    const otherScope = scope();
    const count = store(0);
    const handler = vi.fn(async (amount: number, api: { scope: typeof appScope }) => {
      expect(api.scope).toBe(appScope);
      await Promise.resolve();
      scoped(api.scope, () => {
        count.value += amount;
      });
    });
    let increment!: EventCallable<number>;

    function Counter() {
      increment = action("increment", handler);
      return h("output", null, () => count.value);
    }

    const dispose = render(() => h(Counter), container, { scope: appScope });
    await scoped(appScope, () => increment(3));
    expect(container.textContent).toBe("3");
    expect(handler).toHaveBeenCalledTimes(1);

    await scoped(otherScope, () => increment(5));
    expect(handler).toHaveBeenCalledTimes(1);
    expect(scoped(otherScope, () => count.value)).toBe(0);

    dispose();
    await scoped(appScope, () => increment(7));
    expect(handler).toHaveBeenCalledTimes(1);
    expect(scoped(appScope, () => count.value)).toBe(3);
  });
});
