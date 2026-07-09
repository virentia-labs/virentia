import { describe, expect, it, vi } from "vitest";
import {
  effect,
  event,
  lazyModel,
  reaction,
  scope,
  scoped,
  store,
  type Effect,
  type EventCallable,
  type Store,
} from "../../lib";
import { node } from "../../lib/kernel";
import { setActiveScope } from "../../lib/scope/internal";
import { flush, tick } from "../support/async-flush";
import { makeCounter, type CounterModel } from "../support/lazy-counter";

describe("lazyModel", () => {
  it("starts pending at false", () => {
    const s = scope();
    const model = lazyModel<CounterModel>(async () => makeCounter());

    scoped(s, () => {
      expect(model.pending.value).toBe(false);
    });
  });

  it("does not invoke the loader at creation or on property access", () => {
    let loads = 0;
    const model = lazyModel<CounterModel>(async () => {
      loads += 1;
      return makeCounter();
    });

    void model.incremented;
    void model.count;
    void model.pending;

    expect(loads).toBe(0);
  });

  it("shares a single memoized loader run across parallel access before load", async () => {
    const s = scope();
    let loads = 0;
    const model = lazyModel<CounterModel>(async () => {
      loads += 1;
      return makeCounter();
    });

    await Promise.all([
      scoped(s, () => model.incremented(1)),
      scoped(s, () => model.incremented(2)),
    ]);

    expect(loads).toBe(1);
  });

  it("toggles pending true during load and false after settle per scope", async () => {
    const s = scope();
    let resolveModel!: (m: CounterModel) => void;
    const loaded = new Promise<CounterModel>((resolve) => {
      resolveModel = resolve;
    });
    const model = lazyModel<CounterModel>(() => loaded);

    const loading = scoped(s, () => model.incremented(2));
    await tick();
    scoped(s, () => expect(model.pending.value).toBe(true));

    resolveModel(makeCounter());
    await loading;
    scoped(s, () => expect(model.pending.value).toBe(false));
  });

  it("forwards the exact payload identity to the real unit when launching a lazy event", async () => {
    const s = scope();
    const payload = { token: "abc" };
    const received: unknown[] = [];
    const model = lazyModel<{ ping: EventCallable<{ token: string }> }>(async () => {
      const ping = event<{ token: string }>();
      return { ping };
    });

    reaction({ on: model.ping, run: (value) => received.push(value) });

    await scoped(s, () => model.ping(payload));

    expect(received).toHaveLength(1);
    expect(received[0]).toBe(payload);
  });

  it("fires reactions bound to a lazy event before load once the model loads", async () => {
    const s = scope();
    const received: number[] = [];
    const model = lazyModel<CounterModel>(async () => makeCounter());

    reaction({ on: model.incremented, run: (n: number) => received.push(n) });

    await scoped(s, () => model.incremented(10));
    await scoped(s, () => model.incremented(11));

    expect(received).toEqual([10, 11]);
  });

  it("fires reactions bound to lazy effect lifecycle units once loaded", async () => {
    const s = scope();
    const received: string[] = [];
    const model = lazyModel<{ loadFx: Effect<number, string, Error> }>(async () => ({
      loadFx: effect(async (id: number) => `user:${id}`),
    }));

    reaction({ on: model.loadFx.doneData, run: (v: string) => received.push(v) });

    await scoped(s, () => model.loadFx(7));

    expect(received).toEqual(["user:7"]);
  });

  it("resolves a directly-called lazy effect to the underlying result", async () => {
    const s = scope();
    const model = lazyModel<{ doubleFx: Effect<number, number> }>(async () => ({
      doubleFx: effect(async (v: number) => v * 2),
    }));

    await expect(scoped(s, () => model.doubleFx(4))).resolves.toBe(8);
  });

  it("throws 'Lazy unit is not loaded yet' when a lazy store's value is read before load", () => {
    const s = scope();
    const model = lazyModel<CounterModel>(async () => makeCounter());

    expect(() => scoped(s, () => model.count.value)).toThrow("Lazy unit is not loaded yet");
  });

  it("returns the underlying value from a real store property after load", async () => {
    const s = scope();
    const model = lazyModel<CounterModel>(async () => makeCounter());

    await scoped(s, () => model.incremented(3));

    scoped(s, () => {
      expect(model.count.value).toBe(3);
      // The loaded store proxy exposes its `value` key without leaking `prototype`.
      expect(Reflect.ownKeys(model.count)).toContain("value");
      expect(Reflect.ownKeys(model.count)).not.toContain("prototype");
    });
  });

  it("resolves to the proxy itself because the model is not thenable", async () => {
    const model = lazyModel<CounterModel>(async () => makeCounter());

    expect((model as unknown as { then?: unknown }).then).toBeUndefined();
    const resolved = await (model as unknown as Promise<unknown>);
    expect(resolved).toBe(model);
  });

  it("resolves to the lazy-unit proxy because a lazy unit is not thenable", async () => {
    const model = lazyModel<CounterModel>(async () => makeCounter());
    const lazyUnit = model.incremented;

    expect((lazyUnit as unknown as { then?: unknown }).then).toBeUndefined();
    const resolved = await (lazyUnit as unknown as Promise<unknown>);
    expect(resolved).toBe(lazyUnit);
  });

  it("tags the model as LazyModel and its units as LazyUnit", () => {
    const model = lazyModel<CounterModel>(async () => makeCounter());

    expect(Object.prototype.toString.call(model)).toBe("[object LazyModel]");
    expect(Object.prototype.toString.call(model.incremented)).toBe("[object LazyUnit]");
  });

  it("returns the identical cached lazy unit on repeated property access", () => {
    const model = lazyModel<CounterModel>(async () => makeCounter());

    expect(model.incremented).toBe(model.incremented);
  });

  it("returns the identical cached child on repeated nested lifecycle access", () => {
    const model = lazyModel<{ loadFx: Effect<number, string, Error> }>(async () => ({
      loadFx: effect(async (id: number) => `u:${id}`),
    }));

    expect(model.loadFx.doneData).toBe(model.loadFx.doneData);
  });

  it("reflects the mapped value through a derived lazy unit after load", async () => {
    const s = scope();
    const count = store(0);
    const incremented = event<number>();
    reaction({ on: incremented, run: (n: number) => (count.value += n) });
    const model = lazyModel<CounterModel>(async () => ({ count, incremented }));

    const doubled = (model.count as unknown as Store<number>).map((x) => x * 2) as Store<number>;

    await scoped(s, () => model.incremented(0));

    scoped(s, () => {
      count.value = 3;
      expect(doubled.value).toBe(6);
    });
  });

  it("applies the source map exactly once across several primings", async () => {
    const s = scope();
    // A synthetic callable unit whose `.map` we can spy on directly — a real
    // store is a Proxy that forbids reassigning members, so we model the unit
    // surface (node + callable + map) that createDerivedLazyUnit consumes.
    const mapSpy = vi.fn((_fn: (x: number) => number) => ({ node: node() }));
    const fakeUnit = ((..._args: unknown[]) => "called") as unknown as {
      (...args: unknown[]): unknown;
      node: ReturnType<typeof node>;
      map: typeof mapSpy;
    };
    Object.defineProperty(fakeUnit, "node", { value: node(), enumerable: true });
    fakeUnit.map = mapSpy;

    interface FakeModel {
      fakeUnit: typeof fakeUnit;
    }
    const model = lazyModel<FakeModel>(async () => ({ fakeUnit }));

    // Register a derived lazy unit before load.
    void (model.fakeUnit as unknown as { map: typeof mapSpy }).map((x) => x * 2);

    // Each launch re-runs primeUnit → primeDerived; the `primed` guard must keep
    // the underlying `.map` application to exactly one call.
    await scoped(s, () => (model.fakeUnit as unknown as (n: number) => Promise<unknown>)(1));
    await scoped(s, () => (model.fakeUnit as unknown as (n: number) => Promise<unknown>)(2));

    expect(mapSpy).toHaveBeenCalledTimes(1);
  });

  it("defers subscribe to the real store after load, stopping on unsubscribe", async () => {
    const s = scope();
    const count = store(0);
    const incremented = event<number>();
    reaction({ on: incremented, run: (n: number) => (count.value += n) });
    const model = lazyModel<CounterModel>(async () => ({ count, incremented }));
    const seen: number[] = [];

    const off = scoped(s, () =>
      (model.count as unknown as Store<number>).subscribe((v) => seen.push(v)),
    );

    await scoped(s, () => model.incremented(0));
    await flush();

    scoped(s, () => {
      count.value = 5;
    });
    expect(seen).toEqual([5]);

    off();
    scoped(s, () => {
      count.value = 9;
    });
    expect(seen).toEqual([5]);
  });

  it("never wires the real subscription when unsubscribed before the loader resolves", async () => {
    const s = scope();
    const count = store(0);
    const incremented = event<number>();
    reaction({ on: incremented, run: (n: number) => (count.value += n) });
    const model = lazyModel<CounterModel>(async () => ({ count, incremented }));
    const seen: number[] = [];

    const off = scoped(s, () =>
      (model.count as unknown as Store<number>).subscribe((v) => seen.push(v)),
    );
    // Tear down before the load chain settles: the active flag must gate wiring.
    off();

    await scoped(s, () => model.incremented(0));
    await flush();

    scoped(s, () => {
      count.value = 7;
    });
    expect(seen).toEqual([]);
  });

  it("keeps a pre-load property read as a lazy unit but returns the real member for a post-load first read", async () => {
    const s = scope();
    interface Mixed {
      incremented: EventCallable<number>;
      label: string;
      other: string;
    }
    const model = lazyModel<Mixed>(async () => {
      const incremented = event<number>();
      return { incremented, label: "pinned", other: "fresh" };
    });

    // First access before load → pinned to a lazy unit forever.
    const pinned = model.label as unknown;

    await scoped(s, () => model.incremented(0));

    // Same key still routes through the (===) lazy unit, not the raw string.
    expect(model.label as unknown).toBe(pinned);
    expect(typeof pinned).not.toBe("string");
    // A key first accessed only after load returns the real member directly.
    expect(model.other as unknown).toBe("fresh");
  });

  it("mirrors two pre-load reactions onto the real node without duplicates", async () => {
    const s = scope();
    let realEvent!: EventCallable<number>;
    const model = lazyModel<CounterModel>(async () => {
      const counter = makeCounter();
      realEvent = counter.incremented;
      return counter;
    });

    const r1 = reaction({ on: model.incremented, run: () => {} });
    const r2 = reaction({ on: model.incremented, run: () => {} });

    await scoped(s, () => model.incremented(0));

    const next = realEvent.node.next ?? [];
    expect(next.filter((n) => n === r1.node)).toHaveLength(1);
    expect(next.filter((n) => n === r2.node)).toHaveLength(1);
  });

  it("detaches a reaction removed before load from the real node", async () => {
    const s = scope();
    let realEvent!: EventCallable<number>;
    const model = lazyModel<CounterModel>(async () => {
      const counter = makeCounter();
      realEvent = counter.incremented;
      return counter;
    });

    const fired: number[] = [];
    const kept = reaction({ on: model.incremented, run: (n: number) => fired.push(n) });
    const removed = reaction({ on: model.incremented, run: () => fired.push(-1) });
    removed.stop();

    await scoped(s, () => model.incremented(5));

    const next = realEvent.node.next ?? [];
    expect(next).not.toContain(removed.node);
    expect(next).toContain(kept.node);
    expect(fired).toEqual([5]);
  });

  it("mirrors a reaction node once across re-primes so it fires once", async () => {
    const s = scope();
    let realEvent!: EventCallable<number>;
    const model = lazyModel<CounterModel>(async () => {
      const counter = makeCounter();
      realEvent = counter.incremented;
      return counter;
    });

    const fired: number[] = [];
    const r = reaction({ on: model.incremented, run: (n: number) => fired.push(n) });

    // Two launches re-run primeUnit; the mirror target dedup must not duplicate.
    await scoped(s, () => model.incremented(1));
    await scoped(s, () => model.incremented(2));

    const next = realEvent.node.next ?? [];
    expect(next.filter((n) => n === r.node)).toHaveLength(1);
    expect(fired).toEqual([1, 2]);
  });

  it("primes a child lazy unit synchronously when first accessed after load", async () => {
    const s = scope();
    const model = lazyModel<{ loadFx: Effect<number, string, Error> }>(async () => ({
      loadFx: effect(async (id: number) => `u:${id}`),
    }));

    // Load the model first (no reactions bound yet).
    await scoped(s, () => model.loadFx(1));

    // Now bind a fresh child (doneData) — resolver.watch takes the immediate
    // branch, priming synchronously so the reaction still fires on the next call.
    const received: string[] = [];
    reaction({ on: model.loadFx.doneData, run: (v: string) => received.push(v) });

    await scoped(s, () => model.loadFx(2));

    expect(received).toEqual(["u:2"]);
  });

  it("runs the loader once and toggles both pendings for distinct-property concurrent loads from two scopes", async () => {
    const a = scope();
    const b = scope();
    let loads = 0;
    let resolveModel!: (m: { fxA: Effect<number, number>; fxB: Effect<number, number> }) => void;
    const loaded = new Promise<{ fxA: Effect<number, number>; fxB: Effect<number, number> }>(
      (resolve) => {
        resolveModel = resolve;
      },
    );
    const model = lazyModel<{ fxA: Effect<number, number>; fxB: Effect<number, number> }>(() => {
      loads += 1;
      return loaded;
    });

    // Distinct properties → distinct unit resolvers → both reach the model
    // resolver's load and register their scope as pending.
    const la = scoped(a, () => model.fxA(1));
    const lb = scoped(b, () => model.fxB(2));

    await tick();
    scoped(a, () => expect(model.pending.value).toBe(true));
    scoped(b, () => expect(model.pending.value).toBe(true));

    resolveModel({ fxA: effect(async (n: number) => n), fxB: effect(async (n: number) => n) });
    await Promise.all([la, lb]);

    expect(loads).toBe(1);
    scoped(a, () => expect(model.pending.value).toBe(false));
    scoped(b, () => expect(model.pending.value).toBe(false));
  });

  // When two scopes launch the SAME lazy property concurrently, both participate
  // in the one shared load, so both must see `pending` during it. Each launch now
  // registers its scope with the model resolver, even when the unit's own value
  // promise is already memoized by the first scope's launch.
  it("toggles both scopes' pending for same-property concurrent loads", async () => {
    const a = scope();
    const b = scope();
    let resolveModel!: (m: CounterModel) => void;
    const loaded = new Promise<CounterModel>((resolve) => {
      resolveModel = resolve;
    });
    const model = lazyModel<CounterModel>(() => loaded);

    const la = scoped(a, () => model.incremented(1));
    const lb = scoped(b, () => model.incremented(2));

    await tick();
    const aPending = scoped(a, () => model.pending.value);
    const bPending = scoped(b, () => model.pending.value);

    resolveModel(makeCounter());
    await Promise.all([la, lb]);

    // Both scopes participated in the load, so both should have been pending.
    expect(aPending).toBe(true);
    expect(bPending).toBe(true);
  });

  it("emits pending true once and false once for two launches in one scope", async () => {
    const s = scope();
    let resolveModel!: (m: CounterModel) => void;
    const loaded = new Promise<CounterModel>((resolve) => {
      resolveModel = resolve;
    });
    const model = lazyModel<CounterModel>(() => loaded);
    const pendingLog: boolean[] = [];
    model.pending.subscribe((v) => pendingLog.push(v));

    const l1 = scoped(s, () => model.incremented(1));
    const l2 = scoped(s, () => model.incremented(2));

    await tick();
    resolveModel(makeCounter());
    await Promise.all([l1, l2]);

    expect(pendingLog).toEqual([true, false]);
  });

  it("propagates a loader rejection, flushes pending, and memoizes without retry", async () => {
    const s = scope();
    let loads = 0;
    const boom = new Error("boom");
    const model = lazyModel<CounterModel>(async () => {
      loads += 1;
      throw boom;
    });

    await expect(scoped(s, () => model.incremented(1))).rejects.toBe(boom);
    await expect(scoped(s, () => model.incremented(2))).rejects.toBe(boom);

    expect(loads).toBe(1);
    scoped(s, () => expect(model.pending.value).toBe(false));
  });

  it("rejects with 'Lazy unit is not callable' when a non-callable lazy unit is called", async () => {
    const s = scope();
    const model = lazyModel<CounterModel>(async () => makeCounter());

    await expect(
      scoped(s, () => (model.count as unknown as () => Promise<unknown>)()),
    ).rejects.toThrow("Lazy unit is not callable");
  });

  it("throws 'Scope is required to call' for a lazy unit called with no active scope", () => {
    const model = lazyModel<CounterModel>(async () => makeCounter());

    // Assert against a deterministically empty ambient scope (prior async tests
    // can leave one installed), so this exercises exactly the no-scope path.
    const previous = setActiveScope(null);
    try {
      expect(() => model.incremented(1)).toThrow(/Scope is required to call/);
    } finally {
      setActiveScope(previous);
    }
  });

  it("throws on a set before load and writes through to the real store after load", async () => {
    const s = scope();
    const model = lazyModel<CounterModel>(async () => makeCounter());
    const countUnit = model.count as unknown as { value: number };

    expect(() => {
      countUnit.value = 9;
    }).toThrow("Lazy unit is not loaded yet");

    await scoped(s, () => model.incremented(0));

    scoped(s, () => {
      countUnit.value = 9;
      expect(model.count.value).toBe(9);
    });
  });

  it("returns undefined for a non-pending symbol key on the model", () => {
    const model = lazyModel<CounterModel>(async () => makeCounter());

    expect((model as unknown as Record<symbol, unknown>)[Symbol("x")]).toBeUndefined();
  });

  it("returns the identical pending Store instance on every access", () => {
    const model = lazyModel<CounterModel>(async () => makeCounter());

    expect(model.pending).toBe(model.pending);
  });

  it("includes pending in ownKeys and has before and after load", async () => {
    const s = scope();
    const model = lazyModel<CounterModel>(async () => makeCounter());

    expect(Reflect.ownKeys(model)).toContain("pending");
    expect("pending" in model).toBe(true);

    await scoped(s, () => model.incremented(0));

    expect(Reflect.ownKeys(model)).toContain("pending");
    expect("pending" in model).toBe(true);
    expect(Reflect.ownKeys(model)).toContain("count");
  });
});
