import { describe, expect, it } from "vitest";
import { computed, event, reaction, scope, scoped } from "@virentia/core";
import { mutableStore } from "../lib";

// ---------------------------------------------------------------------------
// Adversarial probes for the mutable subsystem — targeting seams the exhaustive
// gen suite does NOT cover. Each async reactive test follows the same harness as
// mutable.gen.test.ts: create computed, wire a counting reaction + a mutating
// reaction, evaluate once inside the scope to register deps, reset the counter,
// fire the event via `await scoped(...)`.
// ---------------------------------------------------------------------------

describe("mutable adversarial — array length truncation reactivity", () => {
  // CONTRAST: pop() (an array MUTATOR) fires the array NODE path, so a reader of
  // a truncated-away fixed index correctly re-runs. This is the baseline the
  // length-assignment path below fails to match.
  it("PROBE: pop() re-runs a fixed-index reader of the removed index", async () => {
    const s = scope();
    const doPop = event<void>();
    const state = mutableStore({ items: [1, 2, 3] });
    const third = computed(() => state.value.items[2]);
    let runs = 0;
    reaction({ on: third, run: () => void runs++ });
    reaction({ on: doPop, run: () => void state.value.items.pop() });

    scoped(s, () => void third.value);
    runs = 0;

    await scoped(s, () => doPop());
    expect(runs).toBe(1);
    expect(scoped(s, () => third.value)).toBeUndefined();
  });

  // Same observable structural change (index 2 removed), but performed via
  // `arr.length = 1` — which goes through the generic `set` trap with property
  // "length". Because "length" is always already `in` the array, `isNew` misses
  // it; the trap now detects a length change explicitly (isArrayLengthChange) and
  // fires the array NODE path in addition to the `items\x01length` keypath. A
  // reader of `items[2]` tracks `items` and `items[2]`, so it re-runs.
  it("FIXED: arr.length = n truncation re-runs a fixed-index reader (node path fired)", async () => {
    const s = scope();
    const trunc = event<void>();
    const state = mutableStore({ items: [1, 2, 3] });
    const third = computed(() => state.value.items[2]);
    let runs = 0;
    reaction({ on: third, run: () => void runs++ });
    reaction({ on: trunc, run: () => void (state.value.items.length = 1) });

    scoped(s, () => void third.value);
    runs = 0;

    await scoped(s, () => trunc());
    expect(runs).toBe(1); // length-set now fires the array node path too
  });

  // Consequence of the fix: after truncation the reader re-runs AND its cached
  // value tracks the ground truth (undefined), instead of holding the stale 3.
  it("FIXED: fixed-index reader re-runs and sees undefined after arr.length truncation", async () => {
    const s = scope();
    const trunc = event<void>();
    const state = mutableStore({ items: [1, 2, 3] });
    const third = computed(() => state.value.items[2]);
    let runs = 0;
    reaction({ on: third, run: () => void runs++ });
    reaction({ on: trunc, run: () => void (state.value.items.length = 1) });

    scoped(s, () => void third.value);
    runs = 0;

    await scoped(s, () => trunc());

    // The reader was notified by the array node path...
    expect(runs).toBe(1);
    // ...so its cached value now matches the ground truth (undefined).
    expect(scoped(s, () => third.value)).toBeUndefined();
    expect(scoped(s, () => state.value.items[2])).toBeUndefined(); // ground truth
    expect(scoped(s, () => state.value.items.length)).toBe(1);
  });

  // A reader that ITERATES the array reads `length` (onRead items.length) so it
  // DOES re-run on a length truncation — narrowing the bug to readers of a fixed
  // index that never touch `.length`.
  it("PROBE: an iterating reader DOES re-run on arr.length truncation (reads length)", async () => {
    const s = scope();
    const trunc = event<void>();
    const state = mutableStore({ items: [1, 2, 3] });
    const joined = computed(() => state.value.items.join(","));
    let runs = 0;
    reaction({ on: joined, run: () => void runs++ });
    reaction({ on: trunc, run: () => void (state.value.items.length = 1) });

    scoped(s, () => void joined.value);
    runs = 0;

    await scoped(s, () => trunc());
    expect(runs).toBe(1);
    expect(scoped(s, () => joined.value)).toBe("1");
  });

  // Growing an array via out-of-bounds index assignment fires the node path
  // (isNew true), so length readers re-run — contrast confirms the asymmetry is
  // specifically the `length =` set path.
  it("PROBE: arr[k]=v out-of-bounds grow re-runs a length reader (node path fired)", async () => {
    const s = scope();
    const grow = event<void>();
    const state = mutableStore({ items: [1, 2, 3] as number[] });
    const len = computed(() => state.value.items.length);
    let runs = 0;
    reaction({ on: len, run: () => void runs++ });
    reaction({ on: grow, run: () => void (state.value.items[5] = 9) });

    scoped(s, () => void len.value);
    runs = 0;

    await scoped(s, () => grow());
    expect(runs).toBe(1);
    expect(scoped(s, () => state.value.items.length)).toBe(6);
  });
});

describe("mutable adversarial — aliasing & stale proxies", () => {
  // Initial aliasing: the same object appears at two keys. COW must diverge them
  // on the first write (structural-sharing semantics), and per-path reactivity
  // must not cross-fire.
  it("PROBE: shared initial node diverges on write; sibling alias reader untouched", async () => {
    const shared = { k: 1 };
    const state = mutableStore({ a: shared, b: shared });
    const s = scope();
    const editA = event<void>();
    const bReader = computed(() => state.value.b.k);
    let bRuns = 0;
    reaction({ on: bReader, run: () => void bRuns++ });
    reaction({ on: editA, run: () => void (state.value.a.k = 2) });

    scoped(s, () => void bReader.value);
    bRuns = 0;

    await scoped(s, () => editA());
    // a diverged, b keeps the shared base value; b's reader is not cross-fired.
    expect(bRuns).toBe(0);
    scoped(s, () => {
      expect(state.value.a.k).toBe(2);
      expect(state.value.b.k).toBe(1);
    });
    expect(shared.k).toBe(1); // base never mutated
  });

  // Holding a child proxy across an index-shifting mutator and then writing
  // through the STALE proxy. The docs say mutators clear the child cache (i.e.
  // you should re-read). This probe documents the ACTUAL current behavior: the
  // stale proxy still threads its copy up under its OLD key, writing to whatever
  // now occupies that slot. Asserted as current behavior to pin it precisely.
  it("PROBE: writing through a stale child proxy after unshift targets the old index slot", () => {
    const state = mutableStore({
      items: [{ tag: "E" }, { tag: "F" }] as { tag: string; extra?: number }[],
    });
    const s = scope();
    scoped(s, () => {
      const stale = state.value.items[0]; // proxy for element E at index 0
      state.value.items.unshift({ tag: "X" }); // now [X, E, F]; E moved to index 1
      // Writing through the stale proxy uses its cached key "0" and threads a
      // shallow COPY of E up into itemsState.copy["0"] — which is now X's slot.
      stale.extra = 99;
      const snapshot = state.value.items.map((el) => ({ ...el }));
      // OBSERVED corruption: X is silently gone; index 0 became a copy of E with
      // the write applied, and the real E (index 1) never received the write.
      // This is the aliasing hazard of retaining a child proxy across a
      // structural mutator (the design clears the cache and expects a re-read);
      // pinned as a probe, not reported as a bug.
      expect(snapshot[0]).toEqual({ tag: "E", extra: 99 }); // copy of E overwrote X
      expect(snapshot[1]).toEqual({ tag: "E" }); // real E untouched by the write
      expect(snapshot[2]).toEqual({ tag: "F" });
      expect(snapshot.some((el) => el.tag === "X")).toBe(false); // X vanished
    });
  });
});

describe("mutable adversarial — write-then-read & key churn in one transaction", () => {
  it("PROBE: delete then re-add a key in one tx yields the new value and shape", () => {
    const state = mutableStore({ obj: { a: 1 } as Record<string, number> });
    const s = scope();
    scoped(s, () => {
      delete state.value.obj.a;
      expect("a" in state.value.obj).toBe(false);
      state.value.obj.a = 7;
      expect(state.value.obj.a).toBe(7);
      expect(Object.keys(state.value.obj)).toEqual(["a"]);
    });
    scoped(s, () => expect(state.value.obj.a).toBe(7));
  });

  it("PROBE: write then read the same path within one tx sees the pending write", () => {
    const state = mutableStore({ a: { x: 1 } });
    const s = scope();
    scoped(s, () => {
      state.value.a.x = 42;
      expect(state.value.a.x).toBe(42);
      state.value.a.x = state.value.a.x + 1;
      expect(state.value.a.x).toBe(43);
    });
  });

  // A path that starts as an object node and becomes a primitive leaf in a later
  // transaction: the deep reader (of a.x) must re-run because it tracks the `a`
  // prefix, which the assignment `a = 5` fires.
  it("PROBE: a node becoming a leaf re-runs a reader that descended through it", async () => {
    const s = scope();
    const collapse = event<void>();
    const state = mutableStore({ a: { x: 1 } as { x: number } | number });
    const deep = computed(() => {
      const a = state.value.a;
      return typeof a === "object" ? a.x : a;
    });
    let runs = 0;
    reaction({ on: deep, run: () => void runs++ });
    reaction({ on: collapse, run: () => void (state.value.a = 5) });

    scoped(s, () => void deep.value);
    runs = 0;

    await scoped(s, () => collapse());
    expect(runs).toBe(1);
    expect(scoped(s, () => deep.value)).toBe(5);
  });
});

describe("mutable adversarial — sibling key over-notification (documented, not a bug)", () => {
  // Reading `obj.a` reports the `obj` prefix as a dependency (a get walks
  // parent→child). Adding a NEW sibling key `obj.b` fires the `obj` node path
  // (shape change), so the `obj.a` reader re-runs even though `a` did not change.
  // Conservative over-notification, not a correctness defect — pinned so a future
  // refactor that changes it is noticed.
  it("PROBE: adding a sibling key re-runs an existing-key reader (conservative)", async () => {
    const s = scope();
    const addKey = event<void>();
    const state = mutableStore({ obj: { a: 1 } as Record<string, number> });
    // Return a fresh object each eval (the gen-suite RX-COARSE-2 trick) so the
    // downstream reaction fires on every RECOMPUTE — letting us observe whether
    // the `obj.a` reader is invalidated, independent of value equality.
    const aReader = computed(() => ({ v: state.value.obj.a }));
    let runs = 0;
    reaction({ on: aReader, run: () => void runs++ });
    reaction({ on: addKey, run: () => void (state.value.obj.b = 2) });

    scoped(s, () => void aReader.value);
    runs = 0;

    await scoped(s, () => addKey());
    // Descending root->obj reports the `obj` node path as a dep; adding a new key
    // fires that node path, so the `obj.a` reader is recomputed. Conservative
    // over-notification (value of a is unchanged), not a correctness defect.
    expect(runs).toBe(1);
    expect(scoped(s, () => state.value.obj.a)).toBe(1); // value unchanged
  });
});
