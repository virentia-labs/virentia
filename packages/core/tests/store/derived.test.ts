import { describe, expect, it, vi } from "vitest";
import {
  computed,
  reaction,
  reactive,
  readonlyReactive,
  scope,
  scoped,
  store,
} from "../../lib";
import { run } from "../../lib/internal";
import { readonlyStore, readStoreValue } from "../../lib/units/store";
import { readInspectorNodeMeta } from "../../lib/kernel/inspector";
import { flush, readValue } from "../support/store-helpers";

describe("derived store", () => {
  describe("a mapped store", () => {
    it("skips an undefined mapper result", () => {
      const sc = scope();
      const src = store(1);
      const d = src.map((v) => (v > 1 ? v : undefined), undefined);

      scoped(sc, () => {
        expect(d.value).toBe(undefined); // source 1 -> undefined -> skipped, no initialValue
        src.value = 2;
        expect(d.value).toBe(2);
        src.value = 1;
        expect(d.value).toBe(2); // undefined mapper result skipped -> retains 2
      });
    });

    it("lets map arity decide whether the token value is skipped", () => {
      const sc = scope();
      const src = store(1);
      const token = Symbol("token") as unknown as number;
      const noSkip = src.map((v) => v); // 1 arg -> no skip
      const withSkip = src.map((v) => (v > 1 ? v : token), token); // 2 args -> skip on token

      scoped(sc, () => {
        expect(noSkip.value).toBe(1);
        src.value = 2;
        expect(noSkip.value).toBe(2);
        expect(withSkip.value).toBe(2);
        src.value = 1;
        expect(noSkip.value).toBe(1); // no skip -> exposes 1
        expect(withSkip.value).toBe(2); // token result skipped -> retains 2
      });
    });

    it("stays lazy while nothing observes it", () => {
      const sc = scope();
      const s = store(1);
      let calls = 0;
      const d = s.map((v) => {
        calls += 1;
        return v * 2;
      });

      scoped(sc, () => {
        s.value = 5;
      });
      expect(calls).toBe(0); // never computed without a read/observer

      expect(readValue(sc, d)).toBe(10);
      expect(calls).toBe(1);
    });
  });

  describe("a filtered store", () => {
    it("exposes the initial value until the predicate first passes", () => {
      const sc = scope();
      const s = store(0);
      const positive = s.filter((v) => v > 0);

      scoped(sc, () => {
        expect(positive.value).toBe(0); // initial, never the sentinel
        s.value = -1;
        expect(positive.value).toBe(0); // still initial (predicate fails)
        s.value = 4;
        expect(positive.value).toBe(4);
      });
    });

    it("keeps the initial value visible instead of the skip token", () => {
      const appScope = scope();
      const count = store(0);
      const positive = count.filter((value) => value > 0);
      const values: number[] = [];

      reaction({
        on: positive,
        run(value: number) {
          values.push(value);
        },
      });

      scoped(appScope, () => {
        expect(positive.value).toBe(0);
        count.value = -1;
        expect(positive.value).toBe(0);
        count.value = 2;
        expect(positive.value).toBe(2);
      });

      expect(values).toEqual([2]);
    });

    it("toggles emissions on the boundary value", async () => {
      const sc = scope();
      const s = store(1);
      const gated = s.filter((v) => v >= 0);
      const seen: number[] = [];
      const spy = vi.fn((value: number) => seen.push(value));

      reaction({ scope: sc, on: gated, run: spy });

      await run({ unit: s.node, payload: -1, scope: sc }); // skip
      await run({ unit: s.node, payload: 0, scope: sc }); // boundary passes
      await run({ unit: s.node, payload: -5, scope: sc }); // skip
      await run({ unit: s.node, payload: 7, scope: sc }); // passes
      await flush();

      expect(seen).toEqual([0, 7]);
    });
  });

  describe("a filtered computed", () => {
    it("does not leak the internal sentinel before the predicate first passes", () => {
      const sc = scope();
      const n = store(0);
      const c = computed(() => n.value);
      const f = c.filter((v) => v > 0);

      // Contrast: store.filter exposes its initial (see R37).
      expect(readValue(sc, store(0).filter((v) => v > 0))).toBe(0);

      // FIXED: the private defaultSkipToken is never surfaced — computed.filter
      // returns `undefined` before the predicate first passes, not the sentinel.
      const value = readValue(sc, f);
      expect(typeof value).not.toBe("symbol");
      expect(value).toBeUndefined();
    });

    it("never exposes an internal symbol as its value", () => {
      const sc = scope();
      const n = store(0);
      const f = computed(() => n.value).filter((v) => v > 0);
      expect(typeof readValue(sc, f)).not.toBe("symbol");
    });
  });

  describe("a chain of derivations", () => {
    it("propagates once per change through a map-map-filter chain", async () => {
      const sc = scope();
      const src = store(0);
      const chained = src
        .map((v) => v + 1)
        .map((v) => v * 10)
        .filter((v) => v > 15);
      const seen: number[] = [];

      reaction({ scope: sc, on: chained, run: (value: number) => seen.push(value) });

      await run({ unit: src.node, payload: 1, scope: sc }); // 2->20 pass -> 20
      await run({ unit: src.node, payload: 2, scope: sc }); // 3->30 pass -> 30
      await run({ unit: src.node, payload: 0, scope: sc }); // 1->10 fail -> skip
      await flush();

      expect(seen).toEqual([20, 30]);
    });

    it("composes a filter into a map across derived links", () => {
      const sc = scope();
      const s = store(0);
      const chained = s.filter((v) => v % 2 === 0).map((v) => v + 100);

      scoped(sc, () => {
        expect(chained.value).toBe(100); // 0 passes filter -> 100
        s.value = 3; // filter skips -> retains upstream even value 0 -> 100
        expect(chained.value).toBe(100);
        s.value = 4; // passes -> 104
        expect(chained.value).toBe(104);
      });
    });
  });

  it("retains the previous mapped value on a filterMap skip", async () => {
    const sc = scope();
    const s = store(1);
    const label = s.filterMap((v) => (v > 2 ? `#${v}` : "skip"), "skip");
    const seen: string[] = [];

    reaction({ scope: sc, on: label, run: (value: string) => seen.push(value) });

    await run({ unit: s.node, payload: 2, scope: sc }); // skip
    await run({ unit: s.node, payload: 3, scope: sc }); // emit #3
    await run({ unit: s.node, payload: 1, scope: sc }); // skip -> retains #3
    await flush();

    expect(seen).toEqual(["#3"]);
    expect(readValue(sc, label)).toBe("#3");
  });

  it("retains a computed's previous value until a real value resumes it", () => {
    const sc = scope();
    const SKIP = Symbol("skip") as unknown as number;
    const flag = store(true);
    const real = store(5);
    const c = computed(() => (flag.value ? real.value : SKIP), SKIP);
    const seen: number[] = [];

    scoped(sc, () => {
      expect(c.value).toBe(5); // initialise: flag true -> 5
    });
    c.subscribe((value) => seen.push(value));

    scoped(sc, () => {
      flag.value = false; // -> SKIP -> skipped, no notify, retains 5
    });
    expect(seen).toEqual([]);
    expect(readValue(sc, c)).toBe(5);

    scoped(sc, () => {
      real.value = 9; // not a dependency while skipped -> no invalidation
    });
    expect(seen).toEqual([]);

    scoped(sc, () => {
      flag.value = true; // resumes: reads real (9) -> notifies 9
    });
    expect(seen).toEqual([9]);
    expect(readValue(sc, c)).toBe(9);
  });

  describe("readStoreValue", () => {
    it("re-runs a reaction for a tracked computed but not an untracked store", async () => {
      const sc = scope();
      const s = store(0);
      const c = computed(() => s.value * 10);
      let storeRuns = 0;
      let compRuns = 0;

      reaction({
        scope: sc,
        run: () => {
          storeRuns += 1;
          readStoreValue(s);
        },
      });
      reaction({
        scope: sc,
        run: () => {
          compRuns += 1;
          readStoreValue(c);
        },
      });

      expect(storeRuns).toBe(1);
      expect(compRuns).toBe(1);

      await run({ unit: s.node, payload: 1, scope: sc });
      await flush();

      expect(storeRuns).toBe(1); // untracked -> never re-runs
      expect(compRuns).toBe(2); // tracked computed changed -> re-runs
    });

    it("throws on an unregistered object", () => {
      const sc = scope();
      expect(() =>
        scoped(sc, () => {
          readStoreValue({} as never);
        }),
      ).toThrow("Unknown store");
    });
  });

  describe("through the public API", () => {
    it("derives stores with map, filter, and filterMap", async () => {
      const appScope = scope();
      const source = store(1);
      const doubled = source.map((value) => value * 2);
      const even = source.filter((value) => value % 2 === 0);
      const label = source.filterMap((value) => (value > 2 ? `#${value}` : "skip"), "skip");
      const values: unknown[] = [];

      reaction({
        on: doubled,
        run: (value: number) => {
          values.push(["doubled", value]);
        },
      });
      reaction({
        on: even,
        run: (value: number) => {
          values.push(["even", value]);
        },
      });
      reaction({
        on: label,
        run: (value: string) => {
          values.push(["label", value]);
        },
      });

      await run({ unit: source.node, payload: 2, scope: appScope });
      await run({ unit: source.node, payload: 3, scope: appScope });

      expect(values).toEqual([
        ["doubled", 4],
        ["even", 2],
        ["doubled", 6],
        ["label", "#3"],
      ]);
    });
  });
});

describe("node metadata", () => {
  it("reports a store's type, name, key, and flags", () => {
    const s = store(0, undefined, { name: "counter", key: true });
    const meta = readInspectorNodeMeta(s.node);

    expect(meta.type).toBe("store");
    expect(meta.name).toBe("counter");
    expect(meta.key).toBe(true);
    expect(meta.callable).toBe(true);
    expect(meta.writable).toBe(true);
  });

  it("reports a computed's type and name", () => {
    const c = computed(() => 1, undefined, { name: "total" });
    const meta = readInspectorNodeMeta(c.node);

    expect(meta.type).toBe("computed");
    expect(meta.name).toBe("total");
  });

  it("names a derived store after its source and operator", () => {
    const named = store(0, undefined, { name: "count" });
    const anon = store(0);

    expect(readInspectorNodeMeta(named.map((v) => v).node).name).toBe("count.map");
    expect(readInspectorNodeMeta(named.filter((v) => v > 0).node).name).toBe("count.filter");
    expect(
      readInspectorNodeMeta(named.filterMap((v) => v, -1).node).name,
    ).toBe("count.filterMap");
    expect(readInspectorNodeMeta(anon.map((v) => v).node).name).toBeUndefined();
  });

  it("exposes the correct writable flag for each unit kind", () => {
    const s = store(0);
    const ro = readonlyStore(0);
    const c = computed(() => 1);
    const r = reactive({ a: 1 });
    const rr = readonlyReactive({ a: 1 });

    expect(s.node).toBe(s.node);
    expect(s.writable).toBe(true);
    expect(ro.writable).toBe(false);
    expect(c.writable).toBe(false);
    expect(r.writable).toBe(true);
    expect(rr.writable).toBe(false);
    expect(s.map((v) => v).writable).toBe(false);
  });
});
