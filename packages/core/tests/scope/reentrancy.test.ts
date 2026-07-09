import { afterEach, describe, expect, it } from "vitest";
import { effect, event, getCurrentScope, reaction, scope, scoped, store } from "../../lib";
import { resetActiveScope } from "../support/scope-helpers";

afterEach(resetActiveScope);

describe("reentrant scope", () => {
  it("keeps the ambient scope for a later effect call in the same handler", async () => {
    // Regression: an async effect triggered from inside another unit's handler
    // runs through the reentrant `run()` branch. Processing it synchronously
    // sets the active scope to null (restored only in a later microtask), which
    // used to leak into the synchronous caller — the next unit call in the same
    // handler then threw "Scope is required".
    const appScope = scope();
    const trigger = event();

    const first = effect(async () => "first");
    const second = effect(async () => "second");

    const errors: unknown[] = [];
    const started: string[] = [];

    reaction({
      on: trigger,
      run: () => {
        // First async effect drives the scope to null synchronously.
        first().catch((error) => errors.push(error));
        started.push("first");

        // Second call must still see the reaction's ambient scope.
        second().catch((error) => errors.push(error));
        started.push("second");
      },
    });

    await scoped(appScope, () => trigger());

    expect(started).toEqual(["first", "second"]);
    expect(errors).toEqual([]);
  });

  it("restores the ambient scope for a plain event call after a reentrant async effect", async () => {
    const appScope = scope();
    const trigger = event();
    const followUp = event<number>();

    const load = effect(async () => "loaded");

    const received: number[] = [];
    const errors: unknown[] = [];

    reaction({ on: followUp, run: (value: number) => received.push(value) });

    reaction({
      on: trigger,
      run: () => {
        load().catch((error) => errors.push(error));

        // A synchronous event dispatch after the async effect: it captures the
        // ambient scope at call time and must not throw.
        try {
          followUp(42);
        } catch (error) {
          errors.push(error);
        }
      },
    });

    await scoped(appScope, () => trigger());

    expect(errors).toEqual([]);
    expect(received).toEqual([42]);
  });

  it("does not deadlock when a handler awaits an event after another effect", async () => {
    // Regression: awaiting an effect leaves a completed reentrant drain that used
    // to re-install itself as the active drain. A unit call in the handler's
    // continuation (here `await ev()`) then joined that parked drain via
    // `waitForDrain` and hung — the drain only settles once the handler finishes,
    // and the handler was blocked on that very call.
    const s = scope();
    const inner = effect(async () => {});
    const ev = event<string>("e");
    const log: string[] = [];

    const fx = effect(async () => {
      log.push("start");
      await inner();
      log.push("after inner");
      await ev("x");
      log.push("after ev");
    });

    await Promise.race([
      scoped(s, () => fx()),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`deadlock, log=${log.join(",")}`)), 500),
      ),
    ]);

    expect(log).toEqual(["start", "after inner", "after ev"]);
  });

  it("targets the innermost scope from a reentrant scoped in an effect handler", async () => {
    const outer = scope();
    const inner = scope();
    const st = store(0);

    const fx = effect(async () => {
      scoped(inner, () => {
        st.value = 99;
      });
    });

    await scoped(outer, () => fx());

    expect(scoped(inner, () => st.value)).toBe(99);
    expect(scoped(outer, () => st.value)).toBe(0);
    expect(getCurrentScope()).toBe(null);
  });
});
