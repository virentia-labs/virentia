import { describe, expect, it } from "vitest";
import { computed, event, reaction, scope, scoped } from "@virentia/core";
import { mutableStore, unwrap } from "../../lib";

describe("mutableStore", () => {
  describe("copy-on-write", () => {
    it("never mutates the initial on the first divergence and shares untouched siblings", () => {
      const initial = { a: { v: 1 }, b: { v: 2 } };
      const state = mutableStore(initial);
      const s = scope();

      scoped(s, () => {
        state.value.a.v = 10;
      });

      expect(initial).toEqual({ a: { v: 1 }, b: { v: 2 } });
      scoped(s, () => {
        expect(unwrap(state.value.a)).not.toBe(initial.a);
        expect(unwrap(state.value.b)).toBe(initial.b);
      });
    });

    it("copies the ancestor chain of a deep write and shares unrelated branches", () => {
      const initial = { a: { b: { c: 1 }, sib: { keep: true } }, other: { z: 0 } };
      const snapshot = JSON.parse(JSON.stringify(initial));
      const state = mutableStore(initial);
      const s = scope();

      scoped(s, () => {
        state.value.a.b.c = 2;
      });

      scoped(s, () => {
        expect(unwrap(state.value.a)).not.toBe(initial.a);
        expect(unwrap(state.value.a.b)).not.toBe(initial.a.b);
        expect(unwrap(state.value.a.sib)).toBe(initial.a.sib);
        expect(unwrap(state.value.other)).toBe(initial.other);
        expect(state.value.a.b.c).toBe(2);
      });
      // initial is byte-for-byte unchanged.
      expect(initial).toEqual(snapshot);
    });

    it("copies only the touched chain in a nested array of objects", () => {
      const initial = { rows: [{ cells: [1, 2] }, { cells: [3, 4] }] };
      const snapshot = JSON.parse(JSON.stringify(initial));
      const state = mutableStore(initial);
      const s = scope();

      scoped(s, () => {
        state.value.rows[0].cells[1] = 99;
      });

      scoped(s, () => {
        expect(unwrap(state.value.rows)).not.toBe(initial.rows);
        expect(unwrap(state.value.rows[0])).not.toBe(initial.rows[0]);
        // Untouched sibling row stays shared by reference.
        expect(unwrap(state.value.rows[1])).toBe(initial.rows[1]);
        expect(state.value.rows[0].cells[1]).toBe(99);
      });
      // The shared base tree is byte-for-byte untouched.
      expect(initial).toEqual(snapshot);
    });

    // kept: also reads state.value.a.v === 10 back to verify the divergence's new
    // value, which the partner does not.
    it("copies a touched branch and never touches the default", () => {
      const initial = { a: { v: 1 }, b: { v: 2 } };
      const state = mutableStore(initial);
      const s = scope();

      scoped(s, () => {
        state.value.a.v = 10;
      });

      // The default object is untouched (no structuredClone, no in-place on the base).
      expect(initial).toEqual({ a: { v: 1 }, b: { v: 2 } });

      scoped(s, () => {
        expect(state.value.a.v).toBe(10);
        // `a` was copied; `b` is shared with the default by reference.
        expect(unwrap(state.value.a)).not.toBe(initial.a);
        expect(unwrap(state.value.b)).toBe(initial.b);
      });
    });
  });

  describe("an aliased initial node", () => {
    // Initial aliasing: the same object appears at two keys. COW must diverge them
    // on the first write (structural-sharing semantics), and per-path reactivity
    // must not cross-fire.
    it("diverges on write without cross-firing the sibling alias's reader", async () => {
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
  });
});
