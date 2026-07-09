import { afterEach, describe, expect, it } from "vitest";
import { effect, event, getCurrentScope, reaction, scope, scoped, store } from "../../lib";
import type { Scope, ScopedRunner } from "../../lib";
import { unwrapMicroScope } from "../../lib/scope/micro";
import { flush, resetActiveScope } from "../support/scope-helpers";

afterEach(resetActiveScope);

describe("async ambient scope", () => {
  describe("awaiting spawned work", () => {
    it("awaits a transitively-drained multi-hop chain", async () => {
      const s = scope();
      const submitted = event<number>();
      const doubleFx = effect(async (value: number) => {
        await Promise.resolve();
        return value * 2;
      });
      const results: number[] = [];

      submitted.node.next = [doubleFx.node];
      reaction({ on: doubleFx.doneData, run: (value: number) => results.push(value) });

      await scoped(s, () => submitted(3));

      expect(results).toEqual([6]);
      scoped(s, () => {
        expect(doubleFx.pending.value).toBe(false);
        expect(doubleFx.inFlight.value).toBe(0);
      });
    });

    it("ignores work spawned only after the body's own await", async () => {
      const s = scope();
      const ev = event();
      let completed = false;
      let openGate!: () => void;
      const gate = new Promise<void>((resolve) => {
        openGate = resolve;
      });

      reaction({
        on: ev,
        run: async (_payload, api) => {
          await gate;
          scoped(api.scope, () => {
            completed = true;
          });
        },
      });

      await scoped(s, async () => {
        await Promise.resolve();
        // Triggered only AFTER the body's own await → not in the spawn collection.
        ev();
      });

      // scoped resolved even though the reaction is still blocked on the gate.
      expect(completed).toBe(false);

      openGate();
      await flush();
      expect(completed).toBe(true);
    });

    it("does not wait for work spawned through a nested sync scoped boundary", async () => {
      const outer = scope();
      const inner = scope();
      const st = store(0);
      const ev = event();

      let openGate!: () => void;
      const gate = new Promise<void>((resolve) => {
        openGate = resolve;
      });

      reaction({
        on: ev,
        run: async (_p, api) => {
          await gate; // blocks until we explicitly open it
          scoped(api.scope, () => {
            st.value = 42;
          });
        },
      });

      await scoped(outer, async () => {
        // Trigger the inner-scope async reaction from the outer's SYNC body,
        // but through a nested sync scoped boundary. The spawn is registered to
        // the inner (sync) collection, which discards it — so the outer
        // promise resolves without waiting for the gated reaction.
        scoped(inner, () => {
          ev();
        });
      });

      // By-design sharp edge: the reaction is still blocked; outer already resolved.
      expect(scoped(inner, () => st.value)).toBe(0);

      openGate();
      await flush();
      expect(scoped(inner, () => st.value)).toBe(42);
    });
  });

  describe("under a micro-scope", () => {
    it("resolves scoped(fn) writes to the real parent", () => {
      const s = scope();
      const st = store(0);

      let innerScope: Scope | null = null;
      let seenValue = -1;

      scoped(s, () => {
        reaction(() => {
          void st.value; // tracked read to make this an auto-reaction
          // ambient here is a micro-scope over s
          innerScope = scoped(() => {
            // The ambient inside this scoped(fn) is a micro-scope whose real
            // parent is s — not a tautology on getCurrentScope() identity.
            seenValue = unwrapMicroScope(getCurrentScope()) === s ? 1 : 0;
            return getCurrentScope();
          });
        });
      });

      expect(innerScope).not.toBeNull();
      expect(unwrapMicroScope(innerScope)).toBe(s);
      expect(seenValue).toBe(1);
    });

    it("keeps a captured runner pointed at the real parent after the run ends", () => {
      const s = scope();
      const st = store(0);
      let capturedRunner: ScopedRunner | null = null;

      scoped(s, () => {
        reaction(() => {
          void st.value;
          capturedRunner = scoped(); // captures the ambient micro-scope
        });
      });

      expect(capturedRunner).not.toBeNull();
      // Used at top level, no ambient scope now.
      expect(getCurrentScope()).toBe(null);
      const runner = capturedRunner as unknown as ScopedRunner;
      runner(() => {
        st.value = 9;
      });

      expect(scoped(s, () => st.value)).toBe(9);
    });
  });

  describe("under concurrency", () => {
    it.fails("resets the ambient to null instead of leaking a stale scope", async () => {
      const a = scope();
      const b = scope();

      // ACCEPTED LIMITATION (not a scheduled fix): concurrent async scoped() calls
      // are unsupported by design — there is a single global activeScope and JS
      // async frames cannot be isolated from one another. p1 installs `a` and yields;
      // p2 captures the leaked `a` as its "previous scope" and restores to it, so the
      // ambient ends at `a` rather than null. The scope-required guard on unit calls
      // limits the blast radius. Kept as it.fails to mark the boundary: were scopes
      // ever isolated per async frame, this would flip and signal it.
      const p1 = scoped(a, async () => {
        await Promise.resolve();
      });
      const p2 = scoped(b, async () => {
        await Promise.resolve();
      });

      await Promise.all([p1, p2]);

      expect(getCurrentScope()).toBe(null);
    });

    it("lands a post-await write in its own scope, not a concurrent one", async () => {
      const a = scope();
      const b = scope();
      const st = store("initial");

      let releaseA!: () => void;
      const gateA = new Promise<void>((r) => {
        releaseA = r;
      });

      // Start A: it installs `a`, then parks on gateA (ambient stays `a`).
      const pA = scoped(a, async () => {
        await gateA;
        // Post-await write. Doc promise: this lands in `a`.
        st.value = "from-A";
      });

      // Start B synchronously after A parked: installs `b` as the global ambient,
      // then resolves immediately.
      const pB = scoped(b, async () => {
        await Promise.resolve();
      });

      await pB; // let B fully settle; the ambient is now whatever B left behind

      // Now resume A's continuation.
      releaseA();
      await pA;

      // The write should be visible in A's scope (doc: "a write after `await`
      // still lands in `scope`").
      expect(scoped(a, () => st.value)).toBe("from-A");
      // And must NOT have leaked into B's scope.
      expect(scoped(b, () => st.value)).toBe("initial");
    });
  });

  // ACCEPTED LIMITATION (not a scheduled fix): same root cause as the concurrency
  // cases above — an async auto-reaction's per-run micro-scope leaks into the single
  // global ambient across microtasks, so an unrelated top-level read becomes a
  // phantom dependency. Detached/concurrent async scoped is unsupported by design;
  // kept as it.fails to mark the boundary.
  it.fails("does not gain a phantom dependency on a store read outside its body", async () => {
    const s = scope();
    const trigger = store(0);
    const other = store(0); // NEVER read by the reaction body
    let runs = 0;
    const fx = effect(async () => {
      await Promise.resolve();
      return 1;
    });

    scoped(s, () => {
      reaction(async () => {
        runs += 1;
        void trigger.value; // the ONLY intended dependency
        await fx();
        void trigger.value;
      });
    });

    // Drain the entire async settle. An unrelated top-level read of `other` at
    // every boundary is a no-op except while the leaked micro-scope is ambient.
    for (let i = 0; i < 30; i += 1) {
      void other.value;
      await Promise.resolve();
    }

    const runsAfterInitial = runs;
    expect(runsAfterInitial).toBe(1);

    // Mutate `other` in s. The reaction body never read `other`, so it must NOT
    // re-run. It does today — proving the phantom dependency was captured.
    scoped(s, () => {
      other.value = 99;
    });
    await flush(10);

    expect(runs).toBe(runsAfterInitial);
  });
});
