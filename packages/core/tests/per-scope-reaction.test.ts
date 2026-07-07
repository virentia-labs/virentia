import { describe, expect, it } from "vitest";
import { effect, reaction, scope, scoped, store } from "../lib";
import { run } from "../lib/internal";
import { getActiveScope } from "../lib/scope/internal";

describe("per-scope reactions", () => {
  it("an explicit `scope:` reaction reacts only to that scope", async () => {
    const a = scope();
    const b = scope();
    const counter = store(0);
    const seen: number[] = [];

    // Per-scope binding is opt-in through `scope:`, never inferred from the
    // ambient scope at creation.
    reaction({
      scope: a,
      run() {
        seen.push(counter.value);
      },
    });

    expect(seen).toEqual([0]); // initial run in `a`

    // An update in another scope must not reach this reaction.
    await run({ unit: counter.node, payload: 1, scope: b });
    expect(seen).toEqual([0]);

    // An update in its own scope does.
    await run({ unit: counter.node, payload: 2, scope: a });
    expect(seen).toEqual([0, 2]);
  });

  it("a reaction without `scope:` is global and reacts in any scope", async () => {
    const a = scope();
    const b = scope();
    const counter = store(0);
    const seen: number[] = [];

    // No `scope:` and no ambient scope — global. Fires wherever its source
    // changed, and each run reads that firing scope's value.
    reaction(() => {
      seen.push(counter.value);
    });

    expect(seen).toEqual([0]); // creation pass (throwaway scope reads the initial value)

    await run({ unit: counter.node, payload: 1, scope: a });
    await run({ unit: counter.node, payload: 2, scope: b });

    expect(seen).toEqual([0, 1, 2]); // reacted in both scopes
  });

  it("explicit `scope:` reactions keep dependencies isolated across scopes", async () => {
    const a = scope();
    const b = scope();
    const useLeft = store(true);
    const left = store(1);
    const right = store(10);
    const seenA: number[] = [];
    const seenB: number[] = [];

    reaction({
      scope: a,
      run() {
        seenA.push(useLeft.value ? left.value : right.value);
      },
    });
    reaction({
      scope: b,
      run() {
        seenB.push(useLeft.value ? left.value : right.value);
      },
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
