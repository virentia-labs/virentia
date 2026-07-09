import { describe, expect, it } from "vitest";
import { effect, event, reaction, scope, scoped, store } from "../../lib";
import { run } from "../../lib/internal";
import { flush, never, waitForMicrotask } from "../support/async-flush";

describe("effect", () => {
  it("quotes its name in the error thrown for a scope-less call", () => {
    const saveFx = effect((value: number) => value, "saveFx");

    expect(() => saveFx(1)).toThrow(/Scope is required to call effect "saveFx"/);
  });

  it("rejects with \"Effect call requires scope\" when its node is driven without a scope", async () => {
    const saveFx = effect((value: number) => value);

    await expect(run({ unit: saveFx.node, payload: 5 })).rejects.toThrow(
      "Effect call requires scope",
    );
  });

  it("throws when a lifecycle store is read outside a scope", () => {
    const fx = effect(async () => undefined);

    expect(() => fx.pending.value).toThrow(/Scope is required/);
    expect(() => fx.inFlight.value).toThrow(/Scope is required/);
  });

  it("emits started, done, doneData, then settled in order for an async success", async () => {
    const appScope = scope();
    const doubleFx = effect(async (value: number) => value * 2);
    const events: unknown[] = [];

    reaction({ on: doubleFx.started, run: (value) => events.push(["started", value]) });
    reaction({ on: doubleFx.done, run: (value) => events.push(["done", value]) });
    reaction({ on: doubleFx.doneData, run: (value) => events.push(["doneData", value]) });
    reaction({ on: doubleFx.settled, run: (value) => events.push(["settled", value]) });

    const result = await scoped(appScope, () => doubleFx(3));

    expect(result).toBe(6);
    expect(events).toEqual([
      ["started", 3],
      ["done", { params: 3, result: 6 }],
      ["doneData", 6],
      ["settled", { status: "done", params: 3, result: 6 }],
    ]);
    scoped(appScope, () => {
      expect(doubleFx.pending.value).toBe(false);
      expect(doubleFx.inFlight.value).toBe(0);
    });
  });

  it("resolves to the handler result after emitting started, done, doneData, and finally", async () => {
    const appScope = scope();
    const doubleFx = effect(async (value: number) => value * 2);
    const values: unknown[] = [];

    reaction({
      on: doubleFx.started,
      run: (value: number) => {
        values.push(["started", value]);
      },
    });
    reaction({
      on: doubleFx.done,
      run: (value: { params: number; result: number }) => {
        values.push(["done", value]);
      },
    });
    reaction({
      on: doubleFx.doneData,
      run: (value: number) => {
        values.push(["doneData", value]);
      },
    });
    reaction({
      on: doubleFx.finally,
      run: (value: unknown) => {
        values.push(["finally", value]);
      },
    });

    const result = await scoped(appScope, () => doubleFx(3));

    expect(result).toBe(6);
    expect(values).toEqual([
      ["started", 3],
      ["done", { params: 3, result: 6 }],
      ["doneData", 6],
      ["finally", { status: "done", params: 3, result: 6 }],
    ]);
    scoped(appScope, () => {
      expect(doubleFx.pending.value).toBe(false);
      expect(doubleFx.inFlight.value).toBe(0);
    });
  });

  it("resolves a handler's custom thenable through the async path", async () => {
    const appScope = scope();
    const fx = effect<void, string>(
      () =>
        ({
          then: (resolve: (value: string) => void) => resolve("ok"),
        }) as PromiseLike<string>,
    );

    await expect(scoped(appScope, () => fx())).resolves.toBe("ok");
  });

  it("emits failed, failData, then settled when the handler rejects", async () => {
    const appScope = scope();
    const boom = new Error("async boom");
    const failFx = effect<number, string, Error>(async () => {
      throw boom;
    });
    const events: unknown[] = [];

    reaction({ on: failFx.failed, run: (value) => events.push(["failed", value]) });
    reaction({ on: failFx.failData, run: (value) => events.push(["failData", value]) });
    reaction({ on: failFx.settled, run: (value) => events.push(["settled", value]) });

    await expect(scoped(appScope, () => failFx(3))).rejects.toBe(boom);
    expect(events).toEqual([
      ["failed", { params: 3, error: boom }],
      ["failData", boom],
      ["settled", { status: "fail", params: 3, error: boom }],
    ]);
    scoped(appScope, () => {
      expect(failFx.pending.value).toBe(false);
      expect(failFx.inFlight.value).toBe(0);
    });
  });

  it("orders the failure trio failed, failData, then settled", async () => {
    const appScope = scope();
    const fx = effect<void, string, Error>(async () => {
      throw new Error("x");
    });
    const order: string[] = [];

    reaction({ on: fx.failed, run: () => order.push("failed") });
    reaction({ on: fx.failData, run: () => order.push("failData") });
    reaction({ on: fx.settled, run: () => order.push("settled") });

    await expect(scoped(appScope, () => fx())).rejects.toThrow("x");
    expect(order).toEqual(["failed", "failData", "settled"]);
  });

  it("rejects with the handler error after emitting failed, failData, and settled", async () => {
    const appScope = scope();
    const error = new Error("boom");
    const failFx = effect<number, string, Error>(() => {
      throw error;
    });
    const values: unknown[] = [];

    reaction({
      on: failFx.failed,
      run: (value: { params: number; error: Error }) => {
        values.push(["failed", value]);
      },
    });
    reaction({
      on: failFx.failData,
      run: (value: Error) => {
        values.push(["failData", value]);
      },
    });
    reaction({
      on: failFx.settled,
      run: (value: unknown) => {
        values.push(["settled", value]);
      },
    });

    const promise = scoped(appScope, () => failFx(3));

    await expect(promise).rejects.toBe(error);
    expect(values).toEqual([
      ["failed", { params: 3, error }],
      ["failData", error],
      ["settled", { status: "fail", params: 3, error }],
    ]);
    scoped(appScope, () => {
      expect(failFx.pending.value).toBe(false);
      expect(failFx.inFlight.value).toBe(0);
    });
  });

  it("raises inFlight to two for overlapping calls, then drains to zero", async () => {
    const appScope = scope();
    const resolvers = new Map<number, (value: string) => void>();
    const fx = effect(
      (value: number) =>
        new Promise<string>((resolve) => {
          resolvers.set(value, resolve);
        }),
    );

    let call1!: Promise<string>;
    let call2!: Promise<string>;
    scoped(appScope, () => {
      call1 = fx(1);
      call2 = fx(2);
    });
    await flush();

    expect(scoped(appScope, () => fx.inFlight.value)).toBe(2);
    expect(scoped(appScope, () => fx.pending.value)).toBe(true);

    resolvers.get(1)!("a");
    await call1;
    expect(scoped(appScope, () => fx.inFlight.value)).toBe(1);
    expect(scoped(appScope, () => fx.pending.value)).toBe(true);

    resolvers.get(2)!("b");
    await call2;
    expect(scoped(appScope, () => fx.inFlight.value)).toBe(0);
    expect(scoped(appScope, () => fx.pending.value)).toBe(false);
  });

  it("reports pending true with inFlight exactly one inside a started reaction", async () => {
    const appScope = scope();
    const fx = effect((value: number) => value);
    let seen: { pending: boolean; inFlight: number } | null = null;

    reaction({
      on: fx.started,
      run: () => {
        seen = { pending: fx.pending.value, inFlight: fx.inFlight.value };
      },
    });

    await scoped(appScope, () => fx(1));

    expect(seen).not.toBeNull();
    expect(seen!.pending).toBe(true);
    expect(seen!.inFlight).toBe(1);
  });

  it("reports already-decremented counters inside a done reaction", async () => {
    const appScope = scope();
    const fx = effect((value: number) => value);
    let seenInFlight = -1;
    let seenPending = true;

    reaction({
      on: fx.done,
      run: () => {
        seenInFlight = fx.inFlight.value;
        seenPending = fx.pending.value;
      },
    });

    await scoped(appScope, () => fx(1));

    expect(seenInFlight).toBe(0);
    expect(seenPending).toBe(false);
  });

  it("clamps inFlight to zero after an abort settles", async () => {
    const appScope = scope();
    const reason = new Error("stop");
    const fx = effect<void, string, unknown>(() => never<string>());

    const call = scoped(appScope, () => fx());
    await flush();
    await scoped(appScope, () => fx.abort(reason));
    await expect(call).rejects.toBe(reason);

    expect(scoped(appScope, () => fx.inFlight.value)).toBe(0);
    expect(scoped(appScope, () => fx.pending.value)).toBe(false);
  });

  // Regression guard: two concurrent calls of one effect in two scopes each
  // report their own inFlight of 1; the second scope's counter is never
  // contaminated by the first.
  it("tracks inFlight per scope for concurrent calls in two scopes", async () => {
    // FIXED: `inFlight` is now tracked per-scope (WeakMap), so two concurrent
    // calls in two scopes no longer contaminate each other's counter — each scope
    // reads its own 1. (Was a single closure counter reading 2 in the 2nd scope.)
    const scopeA = scope();
    const scopeB = scope();
    const fx = effect((_value: number) => never<string>());

    scoped(scopeA, () => {
      void fx(1);
    });
    scoped(scopeB, () => {
      void fx(2);
    });
    await flush();

    const inflightA = scoped(scopeA, () => fx.inFlight.value);
    const inflightB = scoped(scopeB, () => fx.inFlight.value);

    expect(inflightA).toBe(1);
    // The second scope reads its own isolated count of 1.
    expect(inflightB).toBe(1);
  });

  it("publishes lifecycle stores immediately when an async effect starts inside a transaction", async () => {
    const appScope = scope();
    const submitted = event();
    const value = store(0);
    let resolveFx!: (value: string) => void;
    const saveFx = effect(
      () =>
        new Promise<string>((resolve) => {
          resolveFx = resolve;
        }),
    );
    const pendingValues: boolean[] = [];

    saveFx.pending.subscribe((next) => {
      pendingValues.push(next);
    });
    reaction({
      on: submitted,
      run() {
        value.value = 1;
        void saveFx();
      },
    });

    const promise = scoped(appScope, () => submitted());
    await waitForMicrotask();

    expect(pendingValues).toEqual([true]);
    scoped(appScope, () => {
      expect(value.value).toBe(1);
      expect(saveFx.pending.value).toBe(true);
      expect(saveFx.inFlight.value).toBe(1);
    });

    resolveFx("ok");
    await promise;

    expect(pendingValues).toEqual([true, false]);
    scoped(appScope, () => {
      expect(saveFx.pending.value).toBe(false);
      expect(saveFx.inFlight.value).toBe(0);
    });
  });
});
