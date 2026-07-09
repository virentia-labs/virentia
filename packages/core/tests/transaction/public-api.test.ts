import { describe, expect, it } from "vitest";
import { event, reaction, reactive, scope, scoped, store } from "../../lib";

describe("transaction batching through the public API", () => {
  it("notifies a subscriber once with the final value after several writes in one reaction", async () => {
    const appScope = scope();
    const bump = event();
    const count = store(0);
    const observed: number[] = [];

    reaction({
      on: bump,
      run() {
        count.value += 1;
        count.value += 1;
      },
    });
    reaction({
      on: count,
      run(value) {
        observed.push(value);
      },
    });

    await scoped(appScope, () => bump());

    expect(observed).toEqual([2]);
    scoped(appScope, () => expect(count.value).toBe(2));
  });

  it("fires no downstream notification when a store is written to an Object.is-equal value", async () => {
    const appScope = scope();
    const setSame = event();
    const setNew = event();
    const count = store(0);
    const observed: number[] = [];

    reaction({
      on: setSame,
      run() {
        count.value = 0; // equal to current
      },
    });
    reaction({
      on: setNew,
      run() {
        count.value = 1;
      },
    });
    reaction({
      on: count,
      run(value) {
        observed.push(value);
      },
    });

    await scoped(appScope, () => setSame());
    expect(observed).toEqual([]); // unchanged write suppressed

    await scoped(appScope, () => setNew());
    expect(observed).toEqual([1]); // control: a real change fires
  });

  it("exposes an already-committed store to a reaction on another store in the same transaction", async () => {
    const appScope = scope();
    const trigger = event();
    const a = store(0);
    const b = store(0);
    const seenAWhenBFires: number[] = [];

    reaction({
      on: trigger,
      run() {
        a.value = 1;
        b.value = 1;
      },
    });
    reaction({
      on: b,
      run() {
        // a must already be committed when b's notification runs.
        seenAWhenBFires.push(a.value);
      },
    });

    await scoped(appScope, () => trigger());

    expect(seenAWhenBFires).toEqual([1]);
  });

  it("keeps nested unit calls ordered in a single batched snapshot", async () => {
    const appScope = scope();
    const toggle = event();
    const enable = event();
    const disable = event();
    const metrics = reactive({ items: [] as string[] });
    const snapshots: string[][] = [];

    reaction({
      on: toggle,
      run() {
        void enable();
        void disable();
      },
    });
    reaction({
      on: enable,
      run() {
        metrics.items = [...metrics.items, "enabled"];
      },
    });
    reaction({
      on: disable,
      run() {
        metrics.items = [...metrics.items, "disabled"];
      },
    });
    reaction({
      on: metrics,
      run(value) {
        snapshots.push(value.items);
      },
    });

    await scoped(appScope, () => toggle());

    scoped(appScope, () => expect(metrics.items).toEqual(["enabled", "disabled"]));
    expect(snapshots).toEqual([["enabled", "disabled"]]);
  });

  it("flushes a pre-await store write so it is observable after the await", async () => {
    const appScope = scope();
    const trigger = event();
    const flag = store(0);
    const step = event();
    const seenAfterAwait: number[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    reaction({
      on: trigger,
      run: async () => {
        flag.value = 1; // pre-await write
        await gate; // suspend — drain reaches the commitActiveTransaction boundary
        step(); // observe committed state after resuming
      },
    });
    reaction({
      on: step,
      run() {
        seenAfterAwait.push(flag.value);
      },
    });

    const settled = scoped(appScope, () => trigger());

    // Let the sync portion + microtasks flush; the reaction is suspended on the gate.
    await Promise.resolve();
    // The pre-await write was flushed at the await boundary.
    scoped(appScope, () => expect(flag.value).toBe(1));

    release();
    await settled;

    expect(seenAfterAwait).toEqual([1]);
  });
});
