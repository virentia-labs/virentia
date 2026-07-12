import { describe, expect, it } from "vitest";
import { computed, event, reaction, scope, scoped } from "@virentia/core";
import { mutableStore } from "../../lib";

describe("mutableStore", () => {
  describe("an array length change", () => {
    it("truncates via length=0 and re-runs a length reader", async () => {
      const s = scope();
      const trunc = event<void>();
      const state = mutableStore({ items: [1, 2, 3] });
      const len = computed(() => state.value.items.length);
      let runs = 0;
      reaction({ on: len, run: () => void runs++ });
      reaction({ on: trunc, run: () => void (state.value.items.length = 0) });

      scoped(s, () => void len.value);
      runs = 0;

      await scoped(s, () => trunc());
      expect(runs).toBe(1);
      expect(scoped(s, () => [...state.value.items])).toEqual([]);
    });

    it("grows via length=n, filling with holes", () => {
      const state = mutableStore({ items: [1, 2, 3] });
      const s = scope();
      scoped(s, () => {
        state.value.items.length = 5;
      });
      scoped(s, () => {
        expect(state.value.items.length).toBe(5);
        expect([...state.value.items]).toEqual([1, 2, 3, undefined, undefined]);
      });
    });

    it("punches a hole on delete without changing length", async () => {
      const s = scope();
      const del = event<void>();
      const state = mutableStore({ items: [1, 2, 3] });
      const a1 = computed(() => state.value.items[1]);
      let runs = 0;
      reaction({ on: a1, run: () => void runs++ });
      reaction({ on: del, run: () => void delete state.value.items[1] });

      scoped(s, () => void a1.value);
      runs = 0;

      await scoped(s, () => del());
      expect(runs).toBe(1);
      scoped(s, () => {
        expect(state.value.items.length).toBe(3);
        expect(1 in state.value.items).toBe(false);
        expect(state.value.items[1]).toBeUndefined();
      });
    });

    // CONTRAST: pop() (an array MUTATOR) fires the array NODE path, so a reader of
    // a truncated-away fixed index correctly re-runs. This is the baseline the
    // length-assignment path below matches.
    it("re-runs a fixed-index reader after pop removes that index", async () => {
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
    it("re-runs a fixed-index reader after a length truncation", async () => {
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
    it("leaves a fixed-index reader seeing undefined after a length truncation", async () => {
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
    it("re-runs an iterating reader after a length truncation", async () => {
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
    it("re-runs a length reader after an out-of-bounds index grow", async () => {
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
});
