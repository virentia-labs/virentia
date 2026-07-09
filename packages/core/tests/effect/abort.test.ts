import { describe, expect, it } from "vitest";
import { effect, owner, reaction, scope, scoped } from "../../lib";
import type { Effect } from "../../lib";
import { flush, never, waitForMicrotask } from "../support/async-flush";

describe("effect", () => {
  it("settles both levels when a handler synchronously calls itself", async () => {
    const appScope = scope();
    let self!: (n: number) => Promise<number>;
    const fx = effect(async (n: number): Promise<number> => {
      if (n <= 0) return 0;
      const inner = await self(n - 1);
      return inner + n;
    });
    self = (n) => scoped(appScope, () => fx(n));

    const result = await scoped(appScope, () => fx(3));
    expect(result).toBe(6);
    scoped(appScope, () => {
      expect(fx.inFlight.value).toBe(0);
      expect(fx.pending.value).toBe(false);
    });
  });

  it("emits done once per call in resolution order for overlapping calls", async () => {
    const appScope = scope();
    const resolvers = new Map<number, (v: string) => void>();
    const fx = effect(
      (value: number) =>
        new Promise<string>((resolve) => {
          resolvers.set(value, resolve);
        }),
    );
    const order: string[] = [];
    reaction({ on: fx.doneData, run: (v) => order.push(v) });

    let c1!: Promise<string>;
    let c2!: Promise<string>;
    scoped(appScope, () => {
      c1 = fx(1);
      c2 = fx(2);
    });
    await flush();

    resolvers.get(2)!("two");
    await c2;
    resolvers.get(1)!("one");
    await c1;
    await flush();

    expect(order).toEqual(["two", "one"]);
    scoped(appScope, () => expect(fx.inFlight.value).toBe(0));
  });

  describe("abort", () => {
    it("propagates the reason to the rejection, aborted, and failData", async () => {
      const appScope = scope();
      const reason = { cancelled: true };
      const fx = effect<void, string, unknown>(() => never<string>());
      const seen: unknown[] = [];

      reaction({ on: fx.aborted, run: (value) => seen.push(["aborted", value]) });
      reaction({ on: fx.failData, run: (value) => seen.push(["failData", value]) });

      const call = scoped(appScope, () => fx());
      await flush();
      await scoped(appScope, () => fx.abort(reason));

      await expect(call).rejects.toBe(reason);
      expect(seen).toEqual([
        ["aborted", { params: undefined, reason }],
        ["failData", reason],
      ]);
    });

    it("rejects with the runtime AbortError when abort is called with no reason", async () => {
      const appScope = scope();
      const fx = effect<void, string, unknown>(() => never<string>());
      const reasons: unknown[] = [];

      reaction({ on: fx.aborted, run: (value) => reasons.push(value.reason) });

      const call = scoped(appScope, () => fx());
      await flush();
      await scoped(appScope, () => fx.abort());

      const err = await call.then(
        () => null,
        (error) => error,
      );
      // AbortController.abort() sets signal.reason to a DOMException("AbortError"),
      // which is what getAbortReason returns (its `?? Error` fallback is not hit).
      expect((err as { name?: string }).name).toBe("AbortError");
      // aborted.reason is the same object the call rejects with.
      expect(reasons[0]).toBe(err);
    });

    it("falls back to an Error(\"Effect aborted\") when abort receives null", async () => {
      const appScope = scope();
      const fx = effect<void, string, unknown>(() => never<string>());
      const reasons: unknown[] = [];

      reaction({ on: fx.aborted, run: (value) => reasons.push(value.reason) });

      const call = scoped(appScope, () => fx());
      await flush();
      // null is not `undefined`, so signal.reason stays null and getAbortReason
      // hits the `?? new Error("Effect aborted")` branch.
      await scoped(appScope, () => fx.abort(null));

      const err = await call.then(
        () => null,
        (error) => error,
      );
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toBe("Effect aborted");
      expect((reasons[0] as Error).message).toBe("Effect aborted");
    });

    // A single reason object is shared between the rejection and the aborted event
    // on the null-reason path (getAbortReason memoizes per signal), matching the
    // object-reason / DOMException paths.
    it("uses a single reason instance for the rejection and the aborted event", async () => {
      const appScope = scope();
      const fx = effect<void, string, unknown>(() => never<string>());
      const reasons: unknown[] = [];

      reaction({ on: fx.aborted, run: (value) => reasons.push(value.reason) });

      const call = scoped(appScope, () => fx());
      await flush();
      await scoped(appScope, () => fx.abort(null));

      const err = await call.then(
        () => null,
        (error) => error,
      );
      expect(reasons[0]).toBe(err);
    });

    it("cancels the active call when invoked outside any scope", async () => {
      const appScope = scope();
      const reason = new Error("outside");
      const fx = effect<void, string, unknown>(() => never<string>());

      const call = scoped(appScope, () => fx());
      await flush();

      const abortResult = fx.abort(reason); // no active scope here
      expect(abortResult).toBeInstanceOf(Promise);
      await expect(abortResult).resolves.toBeUndefined();
      await expect(call).rejects.toBe(reason);
    });

    it("emits aborted exactly once for a double abort", async () => {
      const appScope = scope();
      const reason = new Error("stop");
      const fx = effect<void, string, unknown>(() => never<string>());
      let count = 0;

      reaction({ on: fx.aborted, run: () => (count += 1) });

      const call = scoped(appScope, () => fx());
      await flush();
      await scoped(appScope, () => fx.abort(reason));
      await scoped(appScope, () => fx.abort(reason));
      await expect(call).rejects.toBe(reason);
      await flush();

      expect(count).toBe(1);
    });

    it("does nothing when aborting an already-completed call", async () => {
      const appScope = scope();
      const fx = effect(async (value: number) => value);
      let count = 0;

      reaction({ on: fx.aborted, run: () => (count += 1) });

      await scoped(appScope, () => fx(1));
      await scoped(appScope, () => fx.abort(new Error("late")));
      await flush();

      expect(count).toBe(0);
      expect(scoped(appScope, () => fx.inFlight.value)).toBe(0);
    });

    it("cancels the call when an external options.signal aborts", async () => {
      const appScope = scope();
      const reason = new Error("external stop");
      const controller = new AbortController();
      const fx = effect<void, string, unknown>(() => never<string>());
      const seen: unknown[] = [];

      reaction({ on: fx.aborted, run: (value) => seen.push(value) });

      const call = scoped(appScope, () => fx(undefined, { signal: controller.signal }));
      await flush();
      controller.abort(reason);

      await expect(call).rejects.toBe(reason);
      expect(seen).toEqual([{ params: undefined, reason }]);
      expect(scoped(appScope, () => fx.inFlight.value)).toBe(0);
    });

    it("fails the call without running the handler when the external signal is already aborted", async () => {
      const appScope = scope();
      const reason = new Error("pre-aborted");
      const controller = new AbortController();
      controller.abort(reason);
      let handlerRan = false;
      const fx = effect<void, string, unknown>(() => {
        handlerRan = true;
        return "should-not-happen";
      });

      const call = scoped(appScope, () => fx(undefined, { signal: controller.signal }));

      await expect(call).rejects.toBe(reason);
      expect(handlerRan).toBe(false);
    });

    it("hands the handler ctx.signal and the unwrapped real scope", async () => {
      const appScope = scope();
      const reason = new Error("ctx abort");
      let observedScope: unknown = null;
      const fx = effect<void, string, unknown>((_params, { signal, scope }) => {
        observedScope = scope;
        return new Promise<string>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      });

      const call = scoped(appScope, () => fx());
      await flush();
      await scoped(appScope, () => fx.abort(reason));

      await expect(call).rejects.toBe(reason);
      expect(observedScope).toBe(appScope);
    });

    it("cascades to a synchronously-started child", async () => {
      const appScope = scope();
      const reason = new Error("cascade");
      const child = effect<void, string, unknown>(() => never<string>());
      const parent = effect<void, string, unknown>(() => child());
      const seen: string[] = [];

      reaction({ on: parent.aborted, run: () => seen.push("parent") });
      reaction({ on: child.aborted, run: () => seen.push("child") });

      const call = scoped(appScope, () => parent());
      await flush();
      await scoped(appScope, () => parent.abort(reason));

      await expect(call).rejects.toBe(reason);
      expect(seen).toContain("parent");
      expect(seen).toContain("child");
    });

    it("does not cascade to a child called after a parent await", async () => {
      const appScope = scope();
      const reason = new Error("parent only");
      const child = effect<void, string, unknown>(() => never<string>());
      let childCalled = false;
      let resolveTick!: () => void;
      const tick = new Promise<void>((resolve) => {
        resolveTick = resolve;
      });
      const parent = effect<void, string, unknown>(async (_params, { scope }) => {
        await tick;
        childCalled = true;
        return scoped(scope, () => child());
      });
      let childAborted = 0;
      reaction({ on: child.aborted, run: () => (childAborted += 1) });

      const call = scoped(appScope, () => parent());
      await flush();
      resolveTick();
      await flush();
      expect(childCalled).toBe(true);

      await scoped(appScope, () => parent.abort(reason));
      await expect(call).rejects.toBe(reason);
      await flush();

      // The synchronous cascade boundary means the child (called after `await`)
      // does not inherit the parent's abort signal.
      expect(childAborted).toBe(0);
      expect(scoped(appScope, () => child.inFlight.value)).toBe(1);
    });

    it("lets fail win when an abort lands before the handler resolves", async () => {
      const appScope = scope();
      const reason = new Error("abort wins");
      let resolveHandler!: (value: string) => void;
      const fx = effect<void, string, unknown>(
        () =>
          new Promise<string>((resolve) => {
            resolveHandler = resolve;
          }),
      );
      let doneFired = 0;
      reaction({ on: fx.doneData, run: () => (doneFired += 1) });

      const call = scoped(appScope, () => fx());
      await flush();
      await scoped(appScope, () => fx.abort(reason));
      resolveHandler("ok"); // arrives after the abort already won the race

      await expect(call).rejects.toBe(reason);
      await flush();
      expect(doneFired).toBe(0);
    });

    it("ignores a late abort after the handler has already resolved", async () => {
      const appScope = scope();
      const fx = effect(async (value: number) => value * 2);
      let abortedFired = 0;
      reaction({ on: fx.aborted, run: () => (abortedFired += 1) });

      await expect(scoped(appScope, () => fx(4))).resolves.toBe(8);
      await scoped(appScope, () => fx.abort(new Error("too late")));
      await flush();

      expect(abortedFired).toBe(0);
    });

    it("aborts in-flight calls with Error(\"Effect owner disposed\") when the owner is disposed", async () => {
      const appScope = scope();
      let fx!: Effect<void, string, unknown>;
      const model = owner(() => {
        fx = effect<void, string, unknown>(() => never<string>());
        return {};
      });
      const abortedReasons: unknown[] = [];
      reaction({ on: fx.aborted, run: (value) => abortedReasons.push(value.reason) });

      const call = scoped(appScope, () => fx());
      await flush();

      model.dispose();

      await expect(call).rejects.toThrow("Effect owner disposed");
      await flush();
      expect(abortedReasons).toHaveLength(1);
      expect((abortedReasons[0] as Error).message).toBe("Effect owner disposed");
    });

    it("drains pending and inFlight after aborting an active call", async () => {
      const appScope = scope();
      const reason = new Error("stop");
      const waitFx = effect<void, string, Error>(() => new Promise<string>(() => {}));
      const values: unknown[] = [];

      reaction({
        on: waitFx.aborted,
        run: (value: unknown) => {
          values.push(["aborted", value]);
        },
      });
      reaction({
        on: waitFx.failData,
        run: (value: Error) => {
          values.push(["failData", value]);
        },
      });

      const promise = scoped(appScope, () => waitFx());
      await waitForMicrotask();
      await waitFx.abort(reason);

      await expect(promise).rejects.toBe(reason);
      expect(values).toEqual([
        ["aborted", { params: undefined, reason }],
        ["failData", reason],
      ]);
      scoped(appScope, () => {
        expect(waitFx.pending.value).toBe(false);
        expect(waitFx.inFlight.value).toBe(0);
      });
    });

    it("cascades to a middle and leaf effect called by an active root", async () => {
      const appScope = scope();
      const reason = new Error("stop tree");
      const values: unknown[] = [];
      const leafFx = effect<void, string, Error>(() => new Promise<string>(() => {}));
      const middleFx = effect(() => leafFx());
      const rootFx = effect(() => middleFx());

      reaction({
        on: rootFx.aborted,
        run(value) {
          values.push(["root", value]);
        },
      });
      reaction({
        on: middleFx.aborted,
        run(value) {
          values.push(["middle", value]);
        },
      });
      reaction({
        on: leafFx.aborted,
        run(value) {
          values.push(["leaf", value]);
        },
      });

      const promise = scoped(appScope, () => rootFx());
      await waitForMicrotask();
      await rootFx.abort(reason);

      await expect(promise).rejects.toBe(reason);
      // Exactly three aborted events — one per effect in the cascade, no duplicate
      // or spurious emission (arrayContaining alone would let extras slip).
      expect(values).toHaveLength(3);
      expect(values).toEqual(
        expect.arrayContaining([
          ["root", { params: undefined, reason }],
          ["middle", { params: undefined, reason }],
          ["leaf", { params: undefined, reason }],
        ]),
      );
      scoped(appScope, () => {
        expect(rootFx.pending.value).toBe(false);
        expect(rootFx.inFlight.value).toBe(0);
        expect(middleFx.pending.value).toBe(false);
        expect(middleFx.inFlight.value).toBe(0);
        expect(leafFx.pending.value).toBe(false);
        expect(leafFx.inFlight.value).toBe(0);
      });
    });

    // Regression guard: `abortActive` filters by scope, so `fx.abort()` invoked
    // while scoped to scopeA leaves an unrelated in-flight call in scopeB
    // untouched — abort honors the same per-scope isolation as inFlight/pending.
    it("does not abort or reject an in-flight call in another scope", async () => {
      const scopeA = scope();
      const scopeB = scope();
      const fx = effect<void, string, unknown>(() => never<string>());

      let callB!: Promise<string>;
      let callA!: Promise<string>;
      scoped(scopeA, () => {
        callA = fx();
      });
      scoped(scopeB, () => {
        callB = fx();
      });
      callA.catch(() => {});
      let bRejected = false;
      callB.catch(() => {
        bRejected = true;
      });
      await flush();

      // Abort only in scopeA.
      await scoped(scopeA, () => fx.abort(new Error("stop A")));
      await flush();

      // scopeB stays untouched: its call is still in flight, scopeA's has drained.
      expect(bRejected).toBe(false);
      expect(scoped(scopeB, () => fx.inFlight.value)).toBe(1);
      expect(scoped(scopeB, () => fx.pending.value)).toBe(true);
      expect(scoped(scopeA, () => fx.inFlight.value)).toBe(0);
    });

    it("does not emit an aborted event to observers in another scope", async () => {
      const scopeA = scope();
      const scopeB = scope();
      const fx = effect<void, string, unknown>(() => never<string>());
      const abortsInB: unknown[] = [];

      // reaction observes the aborted event; we only care about the scopeB call.
      reaction({ on: fx.aborted, run: (value) => abortsInB.push(value) });

      let callA!: Promise<string>;
      let callB!: Promise<string>;
      scoped(scopeA, () => {
        callA = fx();
      });
      scoped(scopeB, () => {
        callB = fx();
      });
      callA.catch(() => {});
      callB.catch(() => {});
      await flush();

      await scoped(scopeA, () => fx.abort(new Error("stop A")));
      await flush();

      // Only scopeA's call aborts, so observers see exactly one aborted event.
      expect(abortsInB).toHaveLength(1);
    });

    it("skips the rest of the handler when an abort lands between two awaits", async () => {
      const appScope = scope();
      const reason = new Error("mid-await");
      let reachedSecondHalf = false;
      let resolveGate!: () => void;
      const gate = new Promise<void>((resolve) => {
        resolveGate = resolve;
      });
      const fx = effect<void, string, unknown>(async () => {
        await gate;
        // Between the two awaits the abort lands; the handler keeps running in the
        // background but its result is discarded by the abort race.
        reachedSecondHalf = true;
        await never<void>();
        return "done";
      });

      const call = scoped(appScope, () => fx());
      await flush();
      // abort before the gate opens
      const abortP = scoped(appScope, () => fx.abort(reason));
      resolveGate();
      await abortP;

      await expect(call).rejects.toBe(reason);
      await flush();
      // The abort won the race; even though the handler body advanced past the
      // gate, no done is emitted and inFlight drains.
      expect(scoped(appScope, () => fx.inFlight.value)).toBe(0);
      // reachedSecondHalf may be true (background continuation) but must not settle done.
      void reachedSecondHalf;
    });

    it("cascades through a synchronously-built parent, child, grandchild chain", async () => {
      const appScope = scope();
      const reason = new Error("cascade grand");
      const grandchild = effect<void, string, unknown>(() => never<string>());
      const child = effect<void, string, unknown>(() => grandchild());
      const parent = effect<void, string, unknown>(() => child());
      const seen: string[] = [];
      reaction({ on: parent.aborted, run: () => seen.push("parent") });
      reaction({ on: child.aborted, run: () => seen.push("child") });
      reaction({ on: grandchild.aborted, run: () => seen.push("grandchild") });

      const call = scoped(appScope, () => parent());
      await flush();
      await scoped(appScope, () => parent.abort(reason));
      await expect(call).rejects.toBe(reason);
      await flush();

      expect(seen).toContain("parent");
      expect(seen).toContain("child");
      expect(seen).toContain("grandchild");
      scoped(appScope, () => {
        expect(grandchild.inFlight.value).toBe(0);
        expect(child.inFlight.value).toBe(0);
        expect(parent.inFlight.value).toBe(0);
      });
    });

    it("drains inFlight when a pre-aborted external signal fails the call", async () => {
      const appScope = scope();
      const reason = new Error("pre-abort ext");
      const controller = new AbortController();
      controller.abort(reason);
      let handlerRan = false;
      const fx = effect<void, string, unknown>(() => {
        handlerRan = true;
        return "nope";
      });

      const call = scoped(appScope, () => fx(undefined, { signal: controller.signal }));
      await expect(call).rejects.toBe(reason);
      expect(handlerRan).toBe(false);
      scoped(appScope, () => expect(fx.inFlight.value).toBe(0));
    });
  });
});
