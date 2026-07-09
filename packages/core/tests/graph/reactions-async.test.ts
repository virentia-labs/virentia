import { describe, expect, it } from "vitest";
import { effect, event, owner, reaction, scope, scoped, store } from "../../lib";
import type { Reaction, Scope } from "../../lib";
import { run } from "../../lib/internal";
import { isMicroScope } from "../../lib/scope/micro";
import { getActiveScope, setActiveScope } from "../../lib/scope/internal";
import { flush, makeGates, nextOf, observersOf } from "../support/graph-helpers";

// Adversarial probes for the reactions subsystem. These target seams the
// exhaustive gen suite does not: stop()/dispose racing an in-flight ASYNC AUTO
// run, self-loops, and out-of-order latest-wins for 3+ overlapping auto runs.

describe("stopping a parked async auto run", () => {
  // A parked async AUTO run commits its collected deps in its `.then`
  // (commitIfLatest → commitDependencies). Unlike the explicit path, runAuto
  // registers NO AbortController, so stop() cannot cancel it. commitIfLatest
  // therefore guards on `stopped`: a stop() while the run is parked must not let
  // its edges be RESURRECTED when the run later settles. These are regression
  // guards for that guard.
  it("keeps a global reaction's edges detached after the run settles", async () => {
    const a = scope();
    const s = store(0);
    const gates = makeGates();
    const gateFx = effect(async () => {
      await gates.wait();
    });
    let r!: Reaction;

    scoped(a, () => {
      r = reaction(async () => {
        void s.value; // tracked dep, read BEFORE the await
        await gateFx();
      });
    });

    // Creation run is parked in the effect await; deps not committed yet.
    expect(r.dependencies()).toEqual([]);
    expect(nextOf(s.node)).not.toContain(r.node);

    r.stop();
    expect(r.dependencies()).toEqual([]); // stop cleared everything

    gates.release(0);
    await flush();

    // A stopped reaction must never re-attach edges: the parked run's `.then`
    // commit is suppressed by the `stopped` guard, so these stay detached.
    expect(r.dependencies()).toEqual([]);
    expect(nextOf(s.node)).not.toContain(r.node);
  });

  it(
    "keeps a reaction's edges detached when its owner is disposed mid-run",
    async () => {
      const a = scope();
      const s = store(0);
      const gates = makeGates();
      const gateFx = effect(async () => {
        await gates.wait();
      });
      let r!: Reaction;
      let disposeApp!: () => void;

      owner((dispose) => {
        disposeApp = dispose;
        scoped(a, () => {
          r = reaction(async () => {
            void s.value;
            await gateFx();
          });
        });
      });

      disposeApp(); // owner cleanup → r.stop() while the run is parked
      expect(r.dependencies()).toEqual([]);

      gates.release(0);
      await flush();

      // A disposed owner's reaction must stay fully detached.
      expect(nextOf(s.node)).not.toContain(r.node);
      expect(r.dependencies()).toEqual([]);
    },
  );

  it(
    "keeps a per-scope reaction's edges detached",
    async () => {
      const a = scope();
      const s = store(0);
      const gates = makeGates();
      const gateFx = effect(async () => {
        await gates.wait();
      });
      let r!: Reaction;

      scoped(a, () => {
        r = reaction({
          scope: a,
          run: async () => {
            void s.value;
            await gateFx();
          },
        });
      });

      r.stop();
      expect(observersOf(a, s.node)).not.toContain(r.node);

      gates.release(0);
      await flush();

      // Scoped edge must not resurrect after stop().
      expect(observersOf(a, s.node)).not.toContain(r.node);
    },
  );
});

describe("a sync auto self-loop", () => {
  it("runs to a fixpoint and stops", async () => {
    const a = scope();
    const s = store(0);
    const seen: number[] = [];

    reaction({
      scope: a,
      run: () => {
        const v = s.value;
        seen.push(v);
        if (v < 3) s.value = v + 1;
      },
    });

    await flush();
    // Creation reads 0 and writes 1; the write re-fires the reaction, climbing
    // to the fixpoint at 3 where the guard stops the write.
    expect(seen).toEqual([0, 1, 2, 3]);
  });
});

describe("three overlapping async auto runs", () => {
  it("commit only the newest run, regardless of settle order", async () => {
    const a = scope();
    const branch = store(0);
    const s0 = store(0);
    const s1 = store(0);
    const s2 = store(0);
    const gates = makeGates();
    const sources = [s0, s1, s2];
    let r!: Reaction;

    r = reaction({
      scope: a,
      run: async () => {
        const k = branch.value; // always a dep
        void sources[k].value; // branch-specific dep
        await gates.wait();
      },
    });

    // gate[0]: creation (branch=0 → {branch, s0}).
    gates.release(0);
    await flush();
    expect(observersOf(a, s0.node)).toContain(r.node);

    // Start three overlapping runs by flipping branch 0→1→2.
    const p1 = run({ unit: branch.node, payload: 1, scope: a }); // gate[1] → {branch, s1}
    const p2 = run({ unit: branch.node, payload: 2, scope: a }); // gate[2] → {branch, s2} (newest)

    // Settle newest first, then the older one — its stale token must no-op.
    gates.release(2);
    await flush();
    gates.release(1);
    await Promise.all([p1, p2]);
    await flush();

    expect(observersOf(a, s2.node)).toContain(r.node); // newest committed
    expect(observersOf(a, s1.node)).not.toContain(r.node); // stale run did not clobber
    expect(observersOf(a, s0.node)).not.toContain(r.node); // old branch gone
  });
});

describe("a stopped explicit reaction", () => {
  it("leaves its static edge torn down after a parked async run", async () => {
    const a = scope();
    const ev = event<number>();
    const gates = makeGates();
    const gateFx = effect(async () => {
      await gates.wait();
    });
    const seen: number[] = [];
    let r!: Reaction;

    scoped(a, () => {
      r = reaction({
        on: ev,
        run: async (_n, { signal }) => {
          await scoped(a, () => gateFx());
          if (!signal.aborted) seen.push(1);
        },
      });
    });

    expect(nextOf(ev.node)).toContain(r.node);

    const p = run({ unit: ev.node, payload: 1, scope: a });
    r.stop(); // aborts the parked run AND detaches the static `on` edge
    gates.release(0);
    await p;
    await flush();

    // Explicit reactions use static edges detached by stop(); no resurrection,
    // and the aborted body skips its tail.
    expect(nextOf(ev.node)).not.toContain(r.node);
    expect(seen).toEqual([]);
  });
});

describe("an async auto reaction", () => {
  it("runs in a micro-scope aliasing the real scope's values map", () => {
    const a = scope();
    let capturedValues: Scope["values"] | null = null;
    let sawMicro = false;

    scoped(a, () => {
      reaction(() => {
        const active = getActiveScope();
        sawMicro = isMicroScope(active);
        capturedValues = active ? active.values : null;
      });
    });

    expect(sawMicro).toBe(true);
    expect(capturedValues).toBe(a.values); // shared by reference
  });

  it("excludes reads made inside an awaited effect from its dependencies", async () => {
    const a = scope();
    const s = store(0);
    const trig = store(0);
    const fx = effect(async () => s.value);
    const seen: number[] = [];

    scoped(a, () => {
      reaction(async () => {
        void trig.value; // direct dep
        await scoped(a, () => fx()); // fx reads `s` in the real scope, unwrapped
        seen.push(1);
      });
    });

    await flush();
    expect(seen).toEqual([1]);

    await run({ unit: s.node, payload: 5, scope: a }); // s is not a reaction dep
    await flush();
    expect(seen).toEqual([1]); // no re-run

    await run({ unit: trig.node, payload: 1, scope: a }); // trig IS a dep
    await flush();
    expect(seen).toEqual([1, 1]); // re-ran
  });

  it("leaves no micro-scope ambient after a synchronous throw in its body", async () => {
    const a = scope();
    const s = store(0);
    let shouldThrow = false;

    reaction(() => {
      void s.value;
      if (shouldThrow) throw new Error("sync-boom");
    });

    expect(isMicroScope(getActiveScope())).toBe(false);

    shouldThrow = true;
    // A synchronous body throw propagates out of the drain (the run rejects).
    await expect(run({ unit: s.node, payload: 1, scope: a })).rejects.toThrow("sync-boom");

    // The `finally` in runAuto restored the pre-run ambient — no leaked micro-scope.
    expect(isMicroScope(getActiveScope())).toBe(false);
    setActiveScope(null); // reset the (real-scope) ambient the throwing drain left behind
  });

  it("commits its dependencies only after settling, so a pre-settle change does not re-run", async () => {
    const a = scope();
    const pre = store(1);
    const post = store(10);
    const gates = makeGates();
    const seen: number[] = [];
    // The awaited unit is an EFFECT: the kernel preserves the reaction's tracking
    // micro-scope across an effect await, so the post-await `post` read tracks.
    const gateFx = effect(async () => {
      await gates.wait();
    });

    scoped(a, () => {
      reaction(async () => {
        const p = pre.value; // pre-await read
        await gateFx();
        seen.push(p + post.value); // post-await read (tracked across the effect await)
      });
    });

    // Creation run is parked in the effect; `post` edge is not committed yet.
    await run({ unit: post.node, payload: 20, scope: a });
    expect(seen).toEqual([]); // not committed → no re-run, creation still in-flight

    gates.release(0);
    await flush();
    expect(seen).toEqual([21]); // 1 + 20; post now a tracked dep

    const rerun = run({ unit: post.node, payload: 30, scope: a }); // post re-runs it
    gates.release(1);
    await rerun;
    await flush();
    expect(seen).toEqual([21, 31]);
  });
});

describe("overlapping async auto runs", () => {
  it("keep a slower earlier run from clobbering a newer run's dependencies", async () => {
    const a = scope();
    const branch = store(true);
    const x = store(0);
    const y = store(0);
    const gates = makeGates();
    let r!: Reaction;

    r = reaction(async () => {
      const useX = branch.value;
      void (useX ? x.value : y.value);
      await gates.wait();
    });

    // gate[0]: creation (branch=true → reads {branch, x}).
    gates.release(0);
    await flush();
    expect(nextOf(x.node)).toContain(r.node);

    // Overlap two runs in scope `a`, both parked.
    const p1 = run({ unit: x.node, payload: 1, scope: a }); // run1 → gate[1], reads {branch(true), x}
    const p2 = run({ unit: branch.node, payload: false, scope: a }); // run2 → gate[2], reads {branch(false), y}

    // run2 (the newer run) settles first and commits {branch, y}.
    gates.release(2);
    await flush();

    // run1 (older) settles last; its token is stale so its commit is a no-op.
    gates.release(1);
    await Promise.all([p1, p2]);
    await flush();

    expect(nextOf(x.node)).not.toContain(r.node); // run1 did NOT re-attach x
    expect(nextOf(y.node)).toContain(r.node);
    expect(new Set(r.dependencies())).toEqual(new Set([branch.node, y.node]));
  });

  it("commit the latest run's dependencies even when its body rejects", async () => {
    const a = scope();
    const trig = store(0);
    const extra = store(0);
    const gates = makeGates();
    let phase = 0;
    let r!: Reaction;
    // Effect await so the post-await `extra` read tracks into the micro-scope.
    const gateFx = effect(async () => {
      await gates.wait();
    });

    r = reaction(async () => {
      void trig.value;
      await gateFx();
      if (phase >= 1) {
        void extra.value; // a NEW dep, read only by the throwing run
        throw new Error("boom");
      }
    });

    gates.release(0);
    await flush();
    expect(nextOf(extra.node)).not.toContain(r.node);

    phase = 1;
    // Kernel absorbs the async rejection into ctx.failed; the run promise resolves.
    const rerun = run({ unit: trig.node, payload: 1, scope: a });
    gates.release(1);
    await rerun;
    await flush();

    // commitIfLatest ran before the rethrow, so `extra` is now a committed dep.
    expect(nextOf(extra.node)).toContain(r.node);
    expect(new Set(r.dependencies())).toEqual(new Set([trig.node, extra.node]));
  });
});

describe("an explicit reaction", () => {
  it("exposes an idempotent signal within one run", async () => {
    const a = scope();
    const ev = event<number>();
    let s1: AbortSignal | undefined;
    let s2: AbortSignal | undefined;

    scoped(a, () =>
      reaction({
        on: ev,
        run: (_n, api) => {
          s1 = api.signal;
          s2 = api.signal;
        },
      }),
    );

    await scoped(a, () => ev(1));
    expect(s1).toBeInstanceOf(AbortSignal);
    expect(s1).toBe(s2);
  });

  it("allocates no controller for a sync body that never reads signal", async () => {
    const a = scope();
    const ev = event<number>();
    let count = 0;
    let r!: Reaction;

    scoped(a, () => {
      r = reaction({ on: ev, run: () => void (count += 1) });
    });

    await scoped(a, () => ev(1));
    expect(count).toBe(1);
    expect(() => r.stop()).not.toThrow(); // nothing to abort
    await scoped(a, () => ev(2));
    expect(count).toBe(1); // stopped
  });

  it("deregisters a sync body's controller so a later fire cannot abort it", async () => {
    const a = scope();
    const ev = event<number>();
    const signals: AbortSignal[] = [];

    scoped(a, () => reaction({ on: ev, run: (_n, { signal }) => void signals.push(signal) }));

    await scoped(a, () => ev(1));
    await scoped(a, () => ev(2));

    expect(signals).toHaveLength(2);
    expect(signals[0].aborted).toBe(false); // deregistered synchronously; second fire cannot abort it
    expect(signals[1].aborted).toBe(false);
  });

  it("aborts each predecessor on sequential fires, so only the last completes", async () => {
    const a = scope();
    const trigger = event<number>();
    const gates = makeGates();
    const aborted: number[] = [];
    const completed: number[] = [];

    scoped(a, () =>
      reaction({
        on: trigger,
        run: async (n, { signal }) => {
          signal.addEventListener("abort", () => aborted.push(n));
          await gates.wait();
          if (!signal.aborted) completed.push(n);
        },
      }),
    );

    const p1 = run({ unit: trigger.node, payload: 1, scope: a });
    const p2 = run({ unit: trigger.node, payload: 2, scope: a });
    const p3 = run({ unit: trigger.node, payload: 3, scope: a });

    expect(aborted).toEqual([1, 2]); // 2 aborts 1, 3 aborts 2 — synchronously

    gates.releaseAll();
    await Promise.all([p1, p2, p3]);
    expect(completed).toEqual([3]);
  });

  it("clears inFlight on a stale settle only while it is still the current controller", async () => {
    const a = scope();
    const trigger = event<number>();
    const gates = makeGates();
    const aborted: number[] = [];
    const completed: number[] = [];

    scoped(a, () =>
      reaction({
        on: trigger,
        run: async (n, { signal }) => {
          signal.addEventListener("abort", () => aborted.push(n));
          await gates.wait();
          if (!signal.aborted) completed.push(n);
        },
      }),
    );

    const p1 = run({ unit: trigger.node, payload: 1, scope: a }); // gate[0], inFlight=c1
    const p2 = run({ unit: trigger.node, payload: 2, scope: a }); // aborts c1, inFlight=c2
    expect(aborted).toEqual([1]);

    gates.release(0); // run1 settles: inFlight is c2, so it must NOT clear it
    await p1;

    const p3 = run({ unit: trigger.node, payload: 3, scope: a }); // must still abort c2
    expect(aborted).toEqual([1, 2]); // proves run1's settle left inFlight=c2 intact

    gates.release(1);
    gates.release(2);
    await Promise.all([p2, p3]);
    expect(completed).toEqual([3]);
  });

  it("cannot cancel an async body that never reads signal", async () => {
    const a = scope();
    const trigger = event<number>();
    const gates = makeGates();
    const completed: number[] = [];

    scoped(a, () =>
      reaction({
        on: trigger,
        run: async (n) => {
          await gates.wait();
          completed.push(n);
        },
      }),
    );

    const p1 = run({ unit: trigger.node, payload: 1, scope: a });
    const p2 = run({ unit: trigger.node, payload: 2, scope: a });

    gates.releaseAll();
    await Promise.all([p1, p2]);
    expect([...completed].sort()).toEqual([1, 2]); // neither aborted → both complete
  });

  it("awaits a thenable-shaped non-promise return as async", async () => {
    const a = scope();
    const ev = event<number>();
    let thenCalled = false;

    scoped(a, () =>
      reaction({
        on: ev,
        run: (() => ({
          then(resolve: (value: unknown) => void) {
            thenCalled = true;
            resolve(undefined);
          },
        })) as unknown as (payload: number) => void,
      }),
    );

    await scoped(a, () => ev(1));
    expect(thenCalled).toBe(true); // duck-typed detection took the async path
  });
});

describe("scoped draining", () => {
  it("awaits an explicit async body plus a fire-and-forget effect it launches", async () => {
    const appScope = scope();
    const trigger = event<number>();
    const order: string[] = [];
    const gates = makeGates();

    const forgetFx = effect(async () => {
      await gates.wait();
      order.push("forget");
    });
    const awaitedFx = effect(async () => void order.push("awaited"));

    scoped(appScope, () =>
      reaction({
        on: trigger,
        run: async (_n, { scope: fireScope }) => {
          void forgetFx(); // launched, not awaited
          await scoped(fireScope, () => awaitedFx());
        },
      }),
    );

    let settled = false;
    const done = scoped(appScope, () => trigger(1)).then(() => void (settled = true));

    await flush();
    expect(order).toContain("awaited");
    expect(order).not.toContain("forget");
    expect(settled).toBe(false); // drain still waiting on the dangling effect

    gates.releaseAll();
    await done;
    expect(order).toContain("forget");
    expect(settled).toBe(true);
  });

  it("awaits an async explicit reaction body to completion", async () => {
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
          await scoped(scope, () => stepFx(n));
          signal.throwIfAborted();
          log.push(`end:${n}`);
        },
      });
    });

    await scoped(appScope, () => trigger(1));

    // scoped waited for the whole imperative body, including the awaited effect.
    expect(log).toEqual(["start:1", "fx:1", "end:1"]);
  });
});

// TODO(phase2): belongs in scope/async-ambient
describe("scoped effect ambient cleanup", () => {
  it("leaves no ambient scope after an async effect run", async () => {
    const appScope = scope();
    const doubleFx = effect(async (value: number) => value * 2);

    expect(getActiveScope()).toBeNull();

    const result = await scoped(appScope, () => doubleFx(3));

    expect(result).toBe(6);
    expect(getActiveScope()).toBeNull();
  });
});
