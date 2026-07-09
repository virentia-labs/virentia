import { describe, expect, it } from "vitest";
import {
  computed,
  owner,
  reaction,
  reactive,
  readonlyReactive,
  scope,
  scoped,
  seedScopeStoreValue,
  store,
} from "../../lib";
import { run, withTransaction } from "../../lib/internal";
import { readonlyStore } from "../../lib/units/store";
import { flush, readValue } from "../support/store-helpers";

describe("store", () => {
  describe("a scoped write", () => {
    it("round-trips a value inside the scope that wrote it", () => {
      const sc = scope();
      const s = store(10);

      scoped(sc, () => {
        expect(s.value).toBe(10);
        s.value = 20;
        expect(s.value).toBe(20);
      });
    });

    it("keeps each scope's committed value keyed to the store id", () => {
      const a = scope();
      const b = scope();
      const s = store(0);

      scoped(a, () => {
        s.value = 1;
      });
      scoped(b, () => {
        s.value = 2;
      });

      expect(readValue(a, s)).toBe(1);
      expect(readValue(b, s)).toBe(2);
    });
  });

  describe("a rejected write", () => {
    it("throws when a read-only store's value is assigned", () => {
      const sc = scope();
      const s = readonlyStore(0);

      expect(() =>
        scoped(sc, () => {
          (s as unknown as { value: number }).value = 1;
        }),
      ).toThrow("Store is read-only");
    });

    it("throws when a computed's value is assigned", () => {
      const sc = scope();
      const c = computed(() => 1);

      expect(() =>
        scoped(sc, () => {
          (c as unknown as { value: number }).value = 5;
        }),
      ).toThrow("Store is read-only");
    });

    it("throws when a mapped store's value is assigned", () => {
      const sc = scope();
      const d = store(0).map((v) => v * 2);

      expect(() =>
        scoped(sc, () => {
          (d as unknown as { value: number }).value = 10;
        }),
      ).toThrow("Store is read-only");
    });

    it("throws when a property other than value is assigned in ref mode", () => {
      const sc = scope();
      const s = store(0);

      expect(() =>
        scoped(sc, () => {
          (s as unknown as { count: number }).count = 1;
        }),
      ).toThrow("Store value must be written through .value");
    });
  });

  describe("a read without an active scope", () => {
    it("throws that a scope is required", () => {
      const s = store(0);
      expect(() => s.value).toThrow("Scope is required");
    });

    it("names the computed in the scope-required message", () => {
      const c = computed(() => 1, undefined, { name: "total" });
      expect(() => c.value).toThrow(/Scope is required/);
      expect(() => c.value).toThrow(/computed "total"/);
    });

    it("rejects running a store node without a scope", async () => {
      const s = store(0);
      await expect(run({ unit: s.node, payload: 1 })).rejects.toThrow(
        "Store update requires scope",
      );
    });

    it("rejects running a computed node without a scope", async () => {
      const c = computed(() => 1);
      await expect(run({ unit: c.node, payload: undefined })).rejects.toThrow(
        "Computed update requires scope",
      );
    });
  });

  describe("a write equal to the current value", () => {
    it("skips the notification when written through the proxy", () => {
      const sc = scope();
      const s = store(5);
      const seen: number[] = [];
      s.subscribe((value) => seen.push(value));

      scoped(sc, () => {
        s.value = 5;
      });

      expect(seen).toEqual([]);
      expect(readValue(sc, s)).toBe(5);
    });

    it("stops without notifying when the node is run", async () => {
      const sc = scope();
      const s = store(5);
      const seen: number[] = [];
      s.subscribe((value) => seen.push(value));

      await run({ unit: s.node, payload: 5, scope: sc });

      expect(seen).toEqual([]);
      expect(readValue(sc, s)).toBe(5);
    });

    it("treats NaN written over NaN as unchanged", () => {
      const sc = scope();
      const s = store(Number.NaN);
      const seen: number[] = [];
      s.subscribe((value) => seen.push(value));

      scoped(sc, () => {
        s.value = Number.NaN;
      });

      expect(seen).toEqual([]);
    });

    it("notifies with positive zero when it replaces negative zero", () => {
      const sc = scope();
      const s = store(-0);
      const seen: number[] = [];
      s.subscribe((value) => seen.push(value));

      scoped(sc, () => {
        s.value = 0;
      });

      expect(seen).toHaveLength(1);
      expect(Object.is(seen[0], 0)).toBe(true);
      expect(Object.is(seen[0], -0)).toBe(false);
    });
  });

  describe("a store with a skip token", () => {
    it("ignores a proxy write of the skip token", () => {
      const sc = scope();
      const s = store(1, -1);
      const seen: number[] = [];
      s.subscribe((value) => seen.push(value));

      scoped(sc, () => {
        s.value = -1;
      });

      expect(seen).toEqual([]);
      expect(readValue(sc, s)).toBe(1);
    });

    it("keeps the current value when the node is run with the skip token", async () => {
      const sc = scope();
      const s = store(1, -1);
      const seen: number[] = [];
      s.subscribe((value) => seen.push(value));

      await run({ unit: s.node, payload: -1, scope: sc });

      expect(seen).toEqual([]);
      expect(readValue(sc, s)).toBe(1);
    });

    it("skips an undefined write when undefined is the two-argument skip token", () => {
      const sc = scope();
      const s = store<number | undefined>(1, undefined);
      const seen: (number | undefined)[] = [];
      s.subscribe((value) => seen.push(value));

      scoped(sc, () => {
        s.value = undefined;
      });

      expect(seen).toEqual([]);
      expect(readValue(sc, s)).toBe(1);
    });

    it("commits an undefined write when a third devtools argument is present", () => {
      const sc = scope();
      const s = store<number | undefined>(1, undefined, { name: "opt" });
      const seen: (number | undefined)[] = [];
      s.subscribe((value) => seen.push(value));

      scoped(sc, () => {
        s.value = undefined;
      });

      expect(seen).toEqual([undefined]);
      expect(readValue(sc, s)).toBe(undefined);
    });
  });

  describe("a subscriber", () => {
    it("receives nothing until the first change", () => {
      const sc = scope();
      const s = store(7);
      const seen: number[] = [];
      s.subscribe((value) => seen.push(value));

      expect(seen).toEqual([]);

      scoped(sc, () => {
        s.value = 8;
      });
      expect(seen).toEqual([8]);
    });

    it("receives the scope in which each change occurred", async () => {
      const a = scope();
      const b = scope();
      const s = store(0);
      const seen: [number, unknown][] = [];
      s.subscribe((value, scopeArg) => seen.push([value, scopeArg]));

      await run({ unit: s.node, payload: 1, scope: a });
      await run({ unit: s.node, payload: 2, scope: b });

      expect(seen).toEqual([
        [1, a],
        [2, b],
      ]);
    });

    it("receives the run scope of a computed change", () => {
      const a = scope();
      const s = store(0);
      const doubled = computed(() => s.value * 2);
      const seen: [number, unknown][] = [];

      scoped(a, () => doubled.value); // initialise the cache in scope a
      doubled.subscribe((value, scopeArg) => seen.push([value, scopeArg]));

      scoped(a, () => {
        s.value = 5;
      });

      expect(seen).toEqual([[10, a]]);
    });

    it("stops receiving after it unsubscribes", async () => {
      const sc = scope();
      const s = store(0);
      const seen: number[] = [];
      const unsubscribe = s.subscribe((value) => seen.push(value));

      await run({ unit: s.node, payload: 1, scope: sc });
      unsubscribe();
      await run({ unit: s.node, payload: 2, scope: sc });

      expect(seen).toEqual([1]);
    });

    it("stops receiving when its owning owner is disposed", async () => {
      const sc = scope();
      const s = store(0);
      const seen: number[] = [];
      let disposeOwner!: () => void;

      owner((dispose) => {
        disposeOwner = dispose;
        s.subscribe((value) => seen.push(value));
      });

      await run({ unit: s.node, payload: 1, scope: sc });
      expect(seen).toEqual([1]);

      disposeOwner();
      await run({ unit: s.node, payload: 2, scope: sc });
      expect(seen).toEqual([1]);
    });

    it("leaves owner disposal harmless after a manual unsubscribe", async () => {
      const sc = scope();
      const s = store(0);
      const seen: number[] = [];
      let disposeOwner!: () => void;
      let unsubscribe!: () => void;

      owner((dispose) => {
        disposeOwner = dispose;
        unsubscribe = s.subscribe((value) => seen.push(value));
      });

      unsubscribe();
      // Disposing after manual unsubscribe must not throw or double-fire.
      expect(() => disposeOwner()).not.toThrow();
      await run({ unit: s.node, payload: 1, scope: sc });
      expect(seen).toEqual([]);
    });

    it("fires in insertion order alongside other subscribers", async () => {
      const sc = scope();
      const s = store(0);
      const order: string[] = [];
      s.subscribe((value) => order.push(`A:${value}`));
      s.subscribe((value) => order.push(`B:${value}`));

      await run({ unit: s.node, payload: 1, scope: sc });

      expect(order).toEqual(["A:1", "B:1"]);
    });
  });

  describe("a seeded scope value", () => {
    it("sets the committed value silently, bypassing dedup and notify", () => {
      const sc = scope();
      const s = store(0);
      const seen: number[] = [];
      s.subscribe((value) => seen.push(value));

      seedScopeStoreValue(sc, s, 42);

      expect(readValue(sc, s)).toBe(42);
      expect(seen).toEqual([]);
    });

    it("bypasses skipToken gating so even the skip value lands", () => {
      const sc = scope();
      const s = store(1, -1);

      seedScopeStoreValue(sc, s, -1);

      expect(readValue(sc, s)).toBe(-1);
    });

    it("throws for a read-only store", () => {
      const sc = scope();
      const ro = readonlyStore(0);
      expect(() => seedScopeStoreValue(sc, ro as never, 1)).toThrow(
        "Scope values can contain only writable stores",
      );
    });

    it("throws for a read-only reactive or a computed", () => {
      const sc = scope();
      const rr = readonlyReactive({ a: 1 });
      const c = computed(() => 1);
      expect(() => seedScopeStoreValue(sc, rr as never, { a: 2 })).toThrow(
        "Scope values can contain only writable stores",
      );
      expect(() => seedScopeStoreValue(sc, c as never, 1)).toThrow(
        "Scope values can contain only writable stores",
      );
    });

    it("leaves an already-cached computed stale when seeded afterward", () => {
      const sc = scope();
      const src = store(1);
      const doubled = computed(() => src.value * 2);

      expect(scoped(sc, () => doubled.value)).toBe(2); // caches 2 in sc
      seedScopeStoreValue(sc, src, 100); // bypasses invalidation
      expect(scoped(sc, () => doubled.value)).toBe(2); // still stale
    });

    it("feeds a computed read seeded before the first read", () => {
      const sc = scope();
      const src = store(1);
      const doubled = computed(() => src.value * 2);

      seedScopeStoreValue(sc, src, 100); // before any read
      expect(scoped(sc, () => doubled.value)).toBe(200);
    });
  });

  describe("repeated writes inside a transaction", () => {
    it("coalesce latest-wins into one notification", () => {
      const sc = scope();
      const s = store(0);
      const seen: number[] = [];
      s.subscribe((value) => seen.push(value));

      scoped(sc, () => {
        withTransaction(() => {
          s.value = 1;
          s.value = 2;
          s.value = 3;
        });
      });

      expect(seen).toEqual([3]);
      expect(readValue(sc, s)).toBe(3);
    });

    it("read back the pending write while the transaction is open", () => {
      const sc = scope();
      const s = store(0);
      const observed: number[] = [];

      scoped(sc, () => {
        withTransaction(() => {
          s.value = 5;
          observed.push(s.value); // pending read
        });
      });

      expect(observed).toEqual([5]);
      expect(readValue(sc, s)).toBe(5);
    });
  });

  describe("a committed write", () => {
    it("notifies its subscriber exactly once", async () => {
      const sc = scope();
      const s = store(0);
      const subs: number[] = [];
      const reacted: number[] = [];
      s.subscribe((value) => subs.push(value));
      reaction({
        scope: sc,
        run: () => {
          reacted.push(s.value);
        },
      });

      expect(reacted).toEqual([0]); // creation pass

      scoped(sc, () => {
        s.value = 1;
      });
      await flush();

      expect(subs).toEqual([1]); // notified exactly once
      expect(reacted).toEqual([0, 1]); // reaction ran from the propagated update
    });

    it("leaves the final value everywhere after a burst", async () => {
      const sc = scope();
      const s = store(0);
      const reacted: number[] = [];
      reaction({
        scope: sc,
        run: () => {
          reacted.push(s.value);
        },
      });

      scoped(sc, () => {
        withTransaction(() => {
          s.value = 1;
          s.value = 2;
          s.value = 3;
        });
      });
      await flush();

      expect(reacted[reacted.length - 1]).toBe(3);
      expect(readValue(sc, s)).toBe(3);
    });
  });

  it("settles a subscriber's guarded self-retrigger deterministically", () => {
    const sc = scope();
    const s = store(0);
    const seen: number[] = [];
    s.subscribe((value) => {
      seen.push(value);
      if (value < 3) {
        s.value = value + 1; // guarded self-retrigger
      }
    });

    scoped(sc, () => {
      s.value = 1;
    });

    expect(seen).toEqual([1, 2, 3]);
    expect(readValue(sc, s)).toBe(3);
  });

  describe("the same units in two scopes", () => {
    it("keep a computed's dynamic dependencies from cross-contaminating", async () => {
      const a = scope();
      const b = scope();
      const useA = store(true);
      const srcA = store(1);
      const srcB = store(100);
      let computesA = 0;
      let computesB = 0;

      const picked = computed(() => {
        if (useA.value) {
          computesA += 1;
          return srcA.value;
        }
        computesB += 1;
        return srcB.value;
      });

      await run({ unit: useA.node, payload: false, scope: b });

      expect(scoped(a, () => picked.value)).toBe(1);
      expect(scoped(b, () => picked.value)).toBe(100);

      const baseA = computesA;
      const baseB = computesB;

      // Change srcB in a (a reads srcA): must not invalidate a.
      await run({ unit: srcB.node, payload: 200, scope: a });
      expect(scoped(a, () => picked.value)).toBe(1);
      expect(computesA).toBe(baseA);

      // Change srcA in b (b reads srcB): must not invalidate b.
      await run({ unit: srcA.node, payload: 2, scope: b });
      expect(scoped(b, () => picked.value)).toBe(100);
      expect(computesB).toBe(baseB);

      // Change the branch's real dep in each: invalidates precisely.
      await run({ unit: srcA.node, payload: 9, scope: a });
      expect(scoped(a, () => picked.value)).toBe(9);
      await run({ unit: srcB.node, payload: 900, scope: b });
      expect(scoped(b, () => picked.value)).toBe(900);
    });

    it("keep one scope's writes from leaking into another", () => {
      const a = scope();
      const b = scope();
      const s = store(0);
      const seenA: number[] = [];
      const seenB: number[] = [];
      s.subscribe((value, scopeArg) => {
        if (scopeArg === a) seenA.push(value);
        if (scopeArg === b) seenB.push(value);
      });

      scoped(a, () => {
        s.value = 1;
      });
      scoped(b, () => {
        s.value = 2;
      });

      expect(seenA).toEqual([1]);
      expect(seenB).toEqual([2]);
      expect(readValue(a, s)).toBe(1);
      expect(readValue(b, s)).toBe(2);
    });
  });

  describe("through the public API", () => {
    it("keeps proxy state isolated per scope", () => {
      const firstScope = scope();
      const secondScope = scope();
      const counter = store(0);

      scoped(firstScope, () => {
        counter.value = 1;
      });

      scoped(secondScope, () => {
        counter.value = 2;
      });

      scoped(firstScope, () => {
        expect(counter.value).toBe(1);
      });
      scoped(secondScope, () => {
        expect(counter.value).toBe(2);
      });
      expect(() => counter.value).toThrow("Scope is required");
    });

    it("writes object stores through regular property assignment", () => {
      const appScope = scope();
      const user = reactive({ name: "Ada", age: 36 });
      const values: unknown[] = [];
      user.subscribe((value) => {
        values.push(value);
      });

      scoped(appScope, () => {
        user.age = 37;
      });

      scoped(appScope, () => {
        expect(user.name).toBe("Ada");
        expect(user.age).toBe(37);
      });
      expect(values).toEqual([{ name: "Ada", age: 37 }]);
    });

    it("rejects invalid proxy writes", () => {
      const appScope = scope();
      const counter = store(0);
      const doubled = counter.map((value) => value * 2);

      const writeNonValueProperty = () => {
        scoped(appScope, () => {
          (counter as unknown as { count: number }).count = 1;
        });
      };
      const writeReadonlyStore = () => {
        scoped(appScope, () => {
          (doubled as unknown as { value: number }).value = 10;
        });
      };

      expect(writeNonValueProperty).toThrow("Store value must be written through .value");
      expect(writeReadonlyStore).toThrow("Store is read-only");
    });

    it("does not commit skipped values", async () => {
      const appScope = scope();
      const counter = store(1, -1);
      const values: number[] = [];
      counter.subscribe((value) => {
        values.push(value);
      });

      await run({ unit: counter.node, payload: -1, scope: appScope });
      scoped(appScope, () => {
        counter.value = -1;
      });

      scoped(appScope, () => {
        expect(counter.value).toBe(1);
      });
      expect(values).toEqual([]);
    });

    it("does not notify subscribers after unsubscribe", async () => {
      const appScope = scope();
      const counter = store(0);
      const values: number[] = [];
      const unsubscribe = counter.subscribe((value) => {
        values.push(value);
      });

      await run({ unit: counter.node, payload: 1, scope: appScope });
      unsubscribe();
      await run({ unit: counter.node, payload: 2, scope: appScope });

      expect(values).toEqual([1]);
    });
  });
});
