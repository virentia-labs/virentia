import { describe, expect, it } from "vitest";
import { allSettled, effect, event, reaction, scope } from "../lib";

describe("reentrant async effect scope", () => {
  it("keeps the caller's ambient scope after a reentrant async effect resolves synchronously downstream", async () => {
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

    await allSettled(trigger, { scope: appScope });

    expect(started).toEqual(["first", "second"]);
    expect(errors).toEqual([]);
  });

  it("restores the ambient scope for plain event calls after a reentrant async effect", async () => {
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

    await allSettled(trigger, { scope: appScope });

    expect(errors).toEqual([]);
    expect(received).toEqual([42]);
  });
});
