import { describe, expect, it } from "vitest";
import { effect, reaction, run, scope, scoped, store } from "../lib";
import { getActiveScope } from "../lib/scope/internal";

describe("per-scope reactions", () => {
  it("a scope-created reaction reacts only to its own scope", async () => {
    const a = scope();
    const b = scope();
    const counter = store(0);
    const seen: number[] = [];

    // Created inside scope `a` — like a model factory running under scoped(scope).
    scoped(a, () => {
      reaction(() => {
        seen.push(counter.value);
      });
    });

    expect(seen).toEqual([0]); // initial run in `a`

    // An update in another scope must not reach this reaction.
    await run({ unit: counter.node, payload: 1, scope: b });
    expect(seen).toEqual([0]);

    // An update in its own scope does.
    await run({ unit: counter.node, payload: 2, scope: a });
    expect(seen).toEqual([0, 2]);
  });

  it("does not clobber dependencies across scopes when branches differ", async () => {
    const a = scope();
    const b = scope();
    const useLeft = store(true);
    const left = store(1);
    const right = store(10);
    const seenA: number[] = [];
    const seenB: number[] = [];

    scoped(a, () => {
      reaction(() => {
        seenA.push(useLeft.value ? left.value : right.value);
      });
    });
    scoped(b, () => {
      reaction(() => {
        seenB.push(useLeft.value ? left.value : right.value);
      });
    });

    // Scope `b` takes the `right` branch; scope `a` stays on `left`.
    await run({ unit: useLeft.node, payload: false, scope: b });
    await run({ unit: right.node, payload: 11, scope: b });
    // Scope `a` still tracks `left`, untouched by b's reconcile.
    await run({ unit: left.node, payload: 2, scope: a });
    // A `right` change only matters to b now.
    await run({ unit: right.node, payload: 12, scope: b });

    expect(seenA).toEqual([1, 2]); // 1 (init, left), 2 (left→2); never saw b's right updates
    expect(seenB).toEqual([1, 10, 11, 12]); // 1 (init, left), 10 (useLeft→false), 11, 12
  });

  it("leaves no ambient scope after an async effect run via scoped", async () => {
    const appScope = scope();
    const doubleFx = effect(async (value: number) => value * 2);

    expect(getActiveScope()).toBeNull();

    const result = await scoped(appScope, () => doubleFx(3));

    expect(result).toBe(6);
    expect(getActiveScope()).toBeNull();
  });
});
