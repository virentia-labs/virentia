import { describe, expect, it } from "vitest";
import { scope, scoped } from "@virentia/core";
import { mutableStore, unwrap } from "../../lib";

describe("mutableStore", () => {
  describe("array mutators", () => {
    it("apply sort, reverse, fill, copyWithin and splice correctly", () => {
      const s = scope();
      const state = mutableStore({ a: [3, 1, 2, 5, 4] });
      scoped(s, () => {
        state.value.a.sort((x, y) => x - y); // [1,2,3,4,5]
        state.value.a.reverse(); // [5,4,3,2,1]
        state.value.a.fill(0, 0, 1); // [0,4,3,2,1]
        state.value.a.copyWithin(0, 3); // [2,1,3,2,1]
        expect([...state.value.a]).toEqual([2, 1, 3, 2, 1]);
      });
    });

    it("unwrap their arguments, storing a pushed proxy as raw", () => {
      const state = mutableStore({ src: { k: 1 }, list: [] as { k: number }[] });
      const s = scope();
      scoped(s, () => state.value.list.push(state.value.src));
      scoped(s, () => {
        expect(unwrap(state.value.list[0])).toBe(unwrap(state.value.src));
      });
    });

    it("clear cached child drafts", () => {
      const state = mutableStore({ items: [{ id: 0 }] as { id: number }[] });
      const s = scope();
      scoped(s, () => {
        const before = state.value.items[0];
        state.value.items.push({ id: 1 });
        const after = state.value.items[0];
        // The cache was cleared, but both resolve to the same underlying object.
        expect(unwrap(after)).toBe(unwrap(before));
        // Mutating via the freshly-derived proxy affects the current array copy.
        after.id = 99;
        expect(state.value.items[0].id).toBe(99);
      });
    });

    it("apply splice, unshift and push in sequence", () => {
      const s = scope();
      const state = mutableStore({ items: [1, 2, 3] });

      scoped(s, () => {
        state.value.items.splice(1, 1);
        state.value.items.unshift(0);
        state.value.items.push(9);
        expect([...state.value.items]).toEqual([0, 1, 3, 9]);
      });
    });
  });
});
