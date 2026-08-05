import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  computed,
  effect,
  event,
  lazyModel,
  onCleanup,
  owner,
  reaction,
  scope,
  scoped,
  setErrorReporter,
  store,
} from "../../lib";
import type { VirentiaFailureReport } from "../../lib";
import { flush, never } from "../support/async-flush";

// Three behaviours that do not follow from the types and bite during integration.
// Each probe measures the ACTUAL consequence rather than restating the rule.
describe("integration hazards", () => {
  let reports: VirentiaFailureReport[];

  beforeEach(() => {
    reports = [];
    setErrorReporter((failure) => reports.push(failure));
  });

  afterEach(() => {
    setErrorReporter(null);
    vi.restoreAllMocks();
  });

  describe("owner disposal cascades to nested owners", () => {
    it("stops the child's reactions when the parent is disposed", () => {
      const s = scope();
      const $n = store(0);
      const childRuns: number[] = [];
      const parentRuns: number[] = [];

      const parent = owner(() => {
        reaction({ on: $n, run: (v: number) => parentRuns.push(v) });

        const child = owner(() => {
          reaction({ on: $n, run: (v: number) => childRuns.push(v) });

          return {};
        });

        return { child };
      });

      scoped(s, () => {
        $n.value = 1;
      });
      parent.dispose();
      scoped(s, () => {
        $n.value = 2;
      });

      // Both stop: a feature torn down at the route level leaves no live
      // subscription on a global store behind it.
      expect(parentRuns).toEqual([1]);
      expect(childRuns).toEqual([1]);
    });

    it("aborts the child's in-flight effect too", async () => {
      const s = scope();
      let childFx!: ReturnType<typeof effect<void, void, unknown>>;
      const aborted: unknown[] = [];

      const parent = owner(() => {
        const child = owner(() => {
          childFx = effect<void, void, unknown>(() => never<void>());

          return {};
        });

        return { child };
      });

      reaction({ on: childFx.aborted, run: (value) => aborted.push(value) });

      const call = scoped(s, () => childFx()).catch(() => undefined);
      await flush(4);

      parent.dispose();
      await call;
      await flush(20);

      // The child's effect belonged to the child; the child went down with the
      // parent, so the request is cancelled rather than left holding a socket.
      expect(aborted).toHaveLength(1);
      scoped(s, () => {
        expect(childFx.inFlight.value).toBe(0);
      });
    });

    it("still lets a child be disposed on its own, without touching the parent", () => {
      const s = scope();
      const $n = store(0);
      const childRuns: number[] = [];

      const parentRuns: number[] = [];
      const parent = owner(() => {
        reaction({ on: $n, run: (v: number) => parentRuns.push(v) });

        const child = owner(() => {
          reaction({ on: $n, run: (v: number) => childRuns.push(v) });

          return {};
        });

        return { child };
      });

      scoped(s, () => {
        $n.value = 1;
      });
      parent.child.dispose();
      scoped(s, () => {
        $n.value = 2;
      });

      expect(childRuns).toEqual([1]);
      expect(parentRuns).toEqual([1, 2]);
    });
  });

  describe("effect cancellation follows the caller as well as the effect", () => {
    it("cancels a module-level effect when the calling model is disposed", async () => {
      const s = scope();
      // The common shape: the effect is declared once at module scope...
      const sharedFx = effect<void, void, unknown>(() => never<void>());
      const aborted: unknown[] = [];

      reaction({ on: sharedFx.aborted, run: (value) => aborted.push(value) });

      // ...and called from a model that owns the screen.
      const model = owner(() => {
        const call = scoped(s, () => sharedFx()).catch(() => undefined);

        return { call };
      });

      await flush(4);
      model.dispose();
      await model.call;
      await flush(20);

      // The screen is gone, and so is its request.
      expect(aborted).toHaveLength(1);
      expect(String((aborted[0] as { reason: Error }).reason.message)).toBe(
        "Effect caller disposed",
      );
      scoped(s, () => {
        expect(sharedFx.inFlight.value).toBe(0);
      });
    });

    it("does cancel when the effect is created inside the model", async () => {
      const s = scope();
      let ownedFx!: ReturnType<typeof effect<void, void, unknown>>;

      const model = owner(() => {
        ownedFx = effect<void, void, unknown>(() => never<void>());

        return {};
      });
      const aborted: unknown[] = [];

      reaction({ on: ownedFx.aborted, run: (value) => aborted.push(value) });

      const call = scoped(s, () => ownedFx()).catch(() => undefined);
      await flush(4);

      model.dispose();
      await call;
      await flush(20);

      expect(aborted).toHaveLength(1);
    });

    it("leaves a call made outside any owner alone", async () => {
      const s = scope();
      const sharedFx = effect<void, void, unknown>(() => never<void>());
      const aborted: unknown[] = [];

      reaction({ on: sharedFx.aborted, run: (value) => aborted.push(value) });

      const model = owner(() => ({}));
      // Called with no owner current — nothing owns this request.
      const call = scoped(s, () => sharedFx()).catch(() => undefined);

      await flush(4);
      model.dispose();
      await flush(20);

      expect(aborted).toEqual([]);
      scoped(s, () => {
        expect(sharedFx.inFlight.value).toBe(1);
      });

      await scoped(s, () => sharedFx.abort(new Error("done")));
      await call;
    });

    it("cancels only the disposed model's own calls", async () => {
      const s = scope();
      const sharedFx = effect<number, void, unknown>(() => never<void>());
      const aborted: number[] = [];

      reaction({
        on: sharedFx.aborted,
        run: (value: { params: number }) => aborted.push(value.params),
      });

      const first = owner(() => ({ call: scoped(s, () => sharedFx(1)).catch(() => undefined) }));
      const second = owner(() => ({ call: scoped(s, () => sharedFx(2)).catch(() => undefined) }));

      await flush(4);
      first.dispose();
      await first.call;
      await flush(20);

      // Only the first model's request was cancelled.
      expect(aborted).toEqual([1]);
      scoped(s, () => {
        expect(sharedFx.inFlight.value).toBe(1);
      });

      second.dispose();
      await second.call;
      await flush(20);

      expect(aborted).toEqual([1, 2]);
    });
  });

  describe("hazard 3: reading a lazy unit before load", () => {
    it("throws rather than returning a placeholder", () => {
      const s = scope();
      const model = lazyModel<{ $n: ReturnType<typeof store<number>> }>(async () => ({
        $n: store(1),
      }));

      expect(() => scoped(s, () => model.$n.value)).toThrow(/not loaded/i);
    });

    it("surfaces through a reaction as a reported failure, not silence", () => {
      const s = scope();
      const $trigger = store(0);
      const model = lazyModel<{ $n: ReturnType<typeof store<number>> }>(async () => ({
        $n: store(1),
      }));
      const $view = computed(() => model.$n.value * 2);
      const seen: number[] = [];

      reaction({ name: "readsLazy", on: $trigger, run: () => seen.push($view.value) });

      scoped(s, () => {
        $trigger.value = 1;
      });

      // The rule never produced a value...
      expect(seen).toEqual([]);
      // ...but the failure is visible, with the rule named and located.
      expect(reports).toHaveLength(1);
      expect(reports[0]?.unit).toBe('reaction "readsLazy"');
      expect(String((reports[0]?.error as Error).message)).toMatch(/not loaded/i);
    });

    it("is gated by the model's `loaded` flag", async () => {
      const s = scope();
      const model = lazyModel<{
        $n: ReturnType<typeof store<number>>;
        go: ReturnType<typeof event<void>>;
      }>(async () => ({ $n: store(41), go: event<void>() }));

      // The defensive read an integrator wants, now expressible.
      const $safe = computed(() => (model.loaded.value ? model.$n.value : null));

      expect(scoped(s, () => $safe.value)).toBeNull();
      expect(reports).toEqual([]);

      await scoped(s, () => model.go());
      await flush(40);

      expect(scoped(s, () => $safe.value)).toBe(41);
      expect(reports).toEqual([]);
    });

    it("is per-scope: a scope learns it once it takes part in a load", async () => {
      const a = scope();
      const b = scope();
      const model = lazyModel<{
        $n: ReturnType<typeof store<number>>;
        go: ReturnType<typeof event<void>>;
      }>(async () => ({ $n: store(7), go: event<void>() }));

      await scoped(a, () => model.go());
      await flush(40);

      expect(scoped(a, () => model.loaded.value)).toBe(true);
      // `b` has not touched the model yet, so its own flag is still false —
      // the same per-scope shape `pending` already has.
      expect(scoped(b, () => model.loaded.value)).toBe(false);

      await scoped(b, () => model.go());
      await flush(40);

      expect(scoped(b, () => model.loaded.value)).toBe(true);
      expect(scoped(b, () => model.$n.value)).toBe(7);
    });

    it("still reads false on `pending` both before and after load", async () => {
      const s = scope();
      const model = lazyModel<{
        $n: ReturnType<typeof store<number>>;
        go: ReturnType<typeof event<void>>;
      }>(async () => {
        const $n = store(41);
        const go = event<void>();

        return { $n, go };
      });

      expect(scoped(s, () => model.pending.value)).toBe(false);
      expect(() => scoped(s, () => model.$n.value)).toThrow(/not loaded/i);

      await scoped(s, () => model.go());
      await flush(40);

      // Identical flag, opposite meaning: `pending` says "no load in progress",
      // never "loaded". There is no public `loaded` check — `hasValue()` on the
      // internal resolver is not exported — so a defensive read is impossible.
      expect(scoped(s, () => model.pending.value)).toBe(false);
      expect(scoped(s, () => model.$n.value)).toBe(41);
    });

    it("the supported pattern is to trigger the load, then read", async () => {
      const s = scope();
      const model = lazyModel<{
        $n: ReturnType<typeof store<number>>;
        go: ReturnType<typeof event<void>>;
      }>(async () => {
        const $n = store(41);
        const go = event<void>();

        return { $n, go };
      });

      // Calling any lazy unit loads the model; reactions bound to lazy units
      // work before load and fire once it lands.
      await scoped(s, () => model.go());
      await flush(40);

      const $view = computed(() => model.$n.value * 2);

      expect(scoped(s, () => $view.value)).toBe(82);
      expect(reports).toEqual([]);
    });
  });
});
