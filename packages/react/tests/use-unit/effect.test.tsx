// @vitest-environment happy-dom

import {
  effect,
  event,
  reaction,
  scope,
  store,
  type EffectCallOptions,
} from "@virentia/core";
import { fireEvent } from "@testing-library/react";
import { act, createElement } from "react";
import { describe, expect, it } from "vitest";
import { useUnit } from "../../lib";
import { resetAmbientScopeAfterEach } from "../support/ambient-scope-reset";
import { button, deferred, readIn, renderWithScope } from "../support/render-harness";

resetAmbientScopeAfterEach();

describe("useUnit (effect)", () => {
  it("runs the effect in the provided scope and resolves with the done value", async () => {
    const appScope = scope();
    const otherScope = scope();
    const marker = store(0);
    const fx = effect(async (n: number) => {
      marker.value = n; // written under the effect call's scope
      return n * 2;
    });

    let resolved = 0;
    function Runner() {
      const run = useUnit(fx);
      return createElement(
        "button",
        { onClick: async () => (resolved = await run(21)) },
        "run",
      );
    }

    renderWithScope(appScope, createElement(Runner));
    await act(async () => {
      fireEvent.click(button());
    });

    expect(resolved).toBe(42);
    readIn(appScope, () => expect(marker.value).toBe(21));
    readIn(otherScope, () => expect(marker.value).toBe(0));
    readIn(appScope, () => expect(fx.inFlight.value).toBe(0));
  });

  it("rejects the callback promise and fires aborted in scope when aborted mid-flight", async () => {
    const appScope = scope();
    const gate = deferred<void>();
    const fx = effect(async (n: number, _ctx) => {
      await gate.promise;
      return n;
    });

    const abortedIn: number[] = [];
    reaction({
      on: fx.aborted,
      run: () => abortedIn.push(1),
    });

    let run!: (n: number, opts?: EffectCallOptions) => Promise<number>;
    function Runner() {
      run = useUnit(fx);
      return null;
    }
    renderWithScope(appScope, createElement(Runner));

    const controller = new AbortController();
    let rejected = false;
    await act(async () => {
      const p = run(7, { signal: controller.signal });
      controller.abort();
      try {
        await p;
      } catch {
        rejected = true;
      }
      gate.resolve();
    });

    expect(rejected).toBe(true);
    expect(abortedIn.length).toBeGreaterThanOrEqual(1);
  });
});
