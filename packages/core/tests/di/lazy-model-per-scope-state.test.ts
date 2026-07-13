import { describe, expect, it } from "vitest";
import { lazyModel, scope, scoped } from "../../lib";
import { makeCounter, type CounterModel } from "../support/lazy-counter";

describe("lazyModel per-scope state isolation", () => {
  it("keeps each scope's counter independent even though the model object is shared", async () => {
    // One lazy model, loaded once and shared by identity. Its `count` store,
    // however, holds per-scope state (it lives in `scope.values`), so two scopes
    // mutating the same property never see each other's writes.
    const model = lazyModel<CounterModel>(async () => makeCounter());
    const a = scope();
    const b = scope();

    await scoped(a, () => model.incremented(5));
    await scoped(b, () => model.incremented(3));

    // Same shared model, but each scope reads only its own accumulated count.
    expect(scoped(a, () => model.count.value)).toBe(5);
    expect(scoped(b, () => model.count.value)).toBe(3);

    // Further mutations stay isolated and accumulate independently per scope.
    await scoped(a, () => model.incremented(10));
    expect(scoped(a, () => model.count.value)).toBe(15);
    // Scope `b` is untouched by scope `a`'s mutation.
    expect(scoped(b, () => model.count.value)).toBe(3);
  });

  it("shares a single loader run yet initializes each scope's state to the model default", async () => {
    let loads = 0;
    const model = lazyModel<CounterModel>(async () => {
      loads += 1;
      return makeCounter();
    });
    const a = scope();
    const b = scope();

    // Drive the model in `a` only; the loader runs exactly once.
    await scoped(a, () => model.incremented(7));
    await scoped(a, () => model.incremented(1));

    // `b` reads the same shared model but its state starts from the default 0 —
    // it never inherited `a`'s writes.
    await scoped(b, () => model.incremented(2));

    expect(loads).toBe(1);
    expect(scoped(a, () => model.count.value)).toBe(8);
    expect(scoped(b, () => model.count.value)).toBe(2);
  });
});
