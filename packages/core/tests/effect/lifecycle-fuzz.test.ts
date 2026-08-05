import { describe, expect, it } from "vitest";
import { effect, owner, reaction, scope, scoped } from "../../lib";
import { flush } from "../support/async-flush";

function rng(seed: number): () => number {
  let s = seed >>> 0;

  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;

    return s / 0x100000000;
  };
}

interface Ledger {
  started: number;
  done: number;
  failed: number;
  aborted: number;
  settled: number;
}

// Invariants an effect must hold no matter how calls, aborts and owner disposal
// interleave:
//   1. every started call settles exactly once (done XOR failed)
//   2. `settled` fires once per settled call
//   3. inFlight returns to 0 and pending to false once everything drains
//   4. inFlight never goes negative, and at rest pending agrees with it
//
// Deliberately NOT asserted mid-tick: `inFlight` and `pending` are two separate
// stores published one after the other, so an observer of one can momentarily
// see the other stale. Glitch-freedom is not a contract of this core.
async function trial(seed: number): Promise<string | null> {
  const next = rng(seed);
  const s = scope();
  const releases: Array<(value: string) => void> = [];
  const rejects: Array<(error: unknown) => void> = [];

  const fx = effect<number, string, unknown>(
    () =>
      new Promise<string>((resolve, reject) => {
        releases.push(resolve);
        rejects.push(reject);
      }),
  );

  const ledger: Ledger = { started: 0, done: 0, failed: 0, aborted: 0, settled: 0 };
  const observations: Array<{ pending: boolean; inFlight: number }> = [];

  reaction({ on: fx.started, run: () => ledger.started++ });
  reaction({ on: fx.done, run: () => ledger.done++ });
  reaction({ on: fx.failed, run: () => ledger.failed++ });
  reaction({ on: fx.aborted, run: () => ledger.aborted++ });
  reaction({ on: fx.settled, run: () => ledger.settled++ });
  reaction({
    on: fx.inFlight,
    run: (n: number) => {
      observations.push({ pending: scoped(s, () => fx.pending.value), inFlight: n });
    },
  });

  const calls: Array<Promise<unknown>> = [];
  const model = owner(() => ({}));
  let disposed = false;

  for (let step = 0; step < 8; step += 1) {
    const roll = next();

    if (roll < 0.5) {
      calls.push(scoped(s, () => fx(step)).catch(() => "rejected"));
      await flush(2);
    } else if (roll < 0.7 && releases.length > 0) {
      const index = Math.floor(next() * releases.length);
      releases.splice(index, 1)[0]?.(`ok${step}`);
      rejects.splice(index, 1);
      await flush(4);
    } else if (roll < 0.85 && rejects.length > 0) {
      const index = Math.floor(next() * rejects.length);
      rejects.splice(index, 1)[0]?.(new Error(`bad${step}`));
      releases.splice(index, 1);
      await flush(4);
    } else if (roll < 0.95) {
      await scoped(s, () => fx.abort(new Error(`cancel${step}`)));
      await flush(4);
    } else if (!disposed) {
      disposed = true;
      model.dispose();
      await flush(4);
    }
  }

  // Drain whatever is still parked so the run can settle.
  for (const release of releases.splice(0)) release("tail");
  rejects.length = 0;
  await Promise.allSettled(calls);
  await flush(20);

  for (const observation of observations) {
    if (observation.inFlight < 0) {
      return `seed ${seed}: inFlight went negative (${observation.inFlight})`;
    }

  }

  if (ledger.done + ledger.failed !== ledger.started) {
    return `seed ${seed}: ${ledger.started} started but ${ledger.done} done + ${ledger.failed} failed`;
  }

  if (ledger.settled !== ledger.done + ledger.failed) {
    return `seed ${seed}: settled ${ledger.settled} != done+failed ${ledger.done + ledger.failed}`;
  }

  const residual = scoped(s, () => ({
    pending: fx.pending.value,
    inFlight: fx.inFlight.value,
  }));

  if (residual.inFlight !== 0 || residual.pending) {
    return `seed ${seed}: residual pending=${residual.pending} inFlight=${residual.inFlight}`;
  }

  return null;
}

describe("effect lifecycle fuzz", () => {
  it("holds across 60 interleavings of call / settle / abort / dispose", async () => {
    const failures: string[] = [];

    for (let seed = 1; seed <= 60; seed += 1) {
      const failure = await trial(seed);

      if (failure) failures.push(failure);
    }

    expect(failures.slice(0, 5)).toEqual([]);
  });
});
