import { describe, expect, it } from "vitest";
import { allSettled, computed, effect, event, reaction, run, scope, scoped, store } from "../lib";

describe("async reactions", () => {
  it("awaits an async explicit reaction body through allSettled", async () => {
    const appScope = scope();
    const trigger = event<number>();
    const log: string[] = [];
    const stepFx = effect(async (n: number) => {
      log.push(`fx:${n}`);
      return n;
    });

    scoped(appScope, () => {
      reaction({
        on: trigger,
        run: async (n, { scope, signal }) => {
          log.push(`start:${n}`);
          await allSettled(stepFx, { scope, payload: n });
          signal.throwIfAborted();
          log.push(`end:${n}`);
        },
      });
    });

    await allSettled(trigger, { scope: appScope, payload: 1 });

    // allSettled waited for the whole imperative body, including the awaited effect.
    expect(log).toEqual(["start:1", "fx:1", "end:1"]);
  });

  it("awaits a fire-and-forget effect launched inside an async reaction body", async () => {
    const appScope = scope();
    const trigger = event<number>();
    const order: string[] = [];
    let released!: () => void;
    const gate = new Promise<void>((resolve) => {
      released = resolve;
    });

    // Not awaited by the body — completes on its own microtask/gate. The drain
    // must still wait for it before `allSettled` resolves.
    const forgetFx = effect(async () => {
      await gate;
      order.push("forget");
    });
    const awaitedFx = effect(async () => {
      order.push("awaited");
    });

    scoped(appScope, () => {
      reaction({
        on: trigger,
        run: async (_n, { scope }) => {
          // Fire-and-forget: launched under the body's ambient scope, not awaited here.
          void forgetFx();
          await allSettled(awaitedFx, { scope });
        },
      });
    });

    let settledDone = false;
    const settled = allSettled(trigger, { scope: appScope }).then(() => {
      settledDone = true;
    });

    // Flush all microtasks: the awaited effect resolves, but the fire-and-forget
    // one is still gated. allSettled must NOT have resolved yet — the drain is
    // obligated to wait for the dangling effect.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(order).toContain("awaited");
    expect(order).not.toContain("forget");
    expect(settledDone).toBe(false);

    // Releasing the gate lets the effect finish, and only then does allSettled resolve.
    released();
    await settled;
    expect(order).toContain("forget");
    expect(settledDone).toBe(true);
  });

  it("selector + effect runs the effect only when the selected value changes", async () => {
    const appScope = scope();
    const source = store(0);
    const other = store(100);
    const runs: boolean[] = [];

    scoped(appScope, () => {
      reaction(
        () => source.value > 0,
        (positive) => {
          runs.push(positive);
        },
      );
    });

    // Unrelated store — selector value unchanged, effect must not run.
    await run({ unit: other.node, payload: 101, scope: appScope });
    expect(runs).toEqual([]);

    // Selector flips false → true.
    await run({ unit: source.node, payload: 5, scope: appScope });
    expect(runs).toEqual([true]);

    // Selector value unchanged (still > 0) — effect must not run.
    await run({ unit: source.node, payload: 10, scope: appScope });
    expect(runs).toEqual([true]);

    // Selector flips true → false.
    await run({ unit: source.node, payload: 0, scope: appScope });
    expect(runs).toEqual([true, false]);
  });

  it("aborts the previous async run when the reaction fires again (switch)", async () => {
    const appScope = scope();
    const trigger = event<number>();
    const aborted: number[] = [];
    const completed: number[] = [];
    const gates: Array<() => void> = [];

    scoped(appScope, () => {
      reaction({
        on: trigger,
        run: async (n, { signal }) => {
          signal.addEventListener("abort", () => aborted.push(n));
          await new Promise<void>((resolve) => gates.push(resolve));

          if (!signal.aborted) {
            completed.push(n);
          }
        },
      });
    });

    const first = allSettled(trigger, { scope: appScope, payload: 1 });
    const second = allSettled(trigger, { scope: appScope, payload: 2 });

    // The second run aborts the first synchronously.
    expect(aborted).toEqual([1]);

    for (const release of gates) {
      release();
    }

    await Promise.all([first, second]);

    expect(completed).toEqual([2]);
  });

  it("tracks pre- and post-await reads in an async auto reaction (micro-scope)", async () => {
    const appScope = scope();
    const a = store(1);
    const b = store(10);
    const fx = effect(async () => undefined);
    const seen: number[] = [];

    scoped(appScope, () => {
      reaction(async () => {
        const av = a.value; // dependency read before the await
        await fx();
        seen.push(av + b.value); // dependency read AFTER the await
      });
    });

    // Let the initial (creation) run settle.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(seen).toEqual([11]);

    // A pre-await dependency change re-runs the reaction.
    await run({ unit: a.node, payload: 2, scope: appScope });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(seen).toEqual([11, 12]);

    // A post-await dependency change ALSO re-runs it — tracking survived the await.
    await run({ unit: b.node, payload: 20, scope: appScope });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(seen).toEqual([11, 12, 22]);
  });

  it("only the direct reads of the reaction are tracked, not a computed's internals", async () => {
    const appScope = scope();
    const base = store(1);
    const doubled = computed(() => base.value * 2);
    const other = store(100);
    const seen: number[] = [];

    scoped(appScope, () => {
      reaction(() => {
        // Reads the computed (a dep) but NOT `other`. `base` is the computed's
        // own dependency, tracked by the computed, not by this reaction.
        seen.push(doubled.value);
      });
    });

    expect(seen).toEqual([2]);

    // Changing the computed's source re-runs (through the computed).
    await run({ unit: base.node, payload: 5, scope: appScope });
    expect(seen).toEqual([2, 10]);

    // Changing an unrelated store does not.
    await run({ unit: other.node, payload: 200, scope: appScope });
    expect(seen).toEqual([2, 10]);
  });
});
