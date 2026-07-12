import { describe, expect, it } from "vitest";
import { computed, event, reaction, scope, scoped } from "@virentia/core";
import { mutableStore } from "../../lib";

describe("mutableStore", () => {
  describe("array index reactivity", () => {
    it("re-runs a reader of items[0] exactly once on a splice at index 0", async () => {
      const s = scope();
      const doSplice = event<void>();
      const cart = mutableStore({ items: [1, 2, 3] });
      const first = computed(() => cart.value.items[0]);
      let runs = 0;
      reaction({ on: first, run: () => void runs++ });
      reaction({ on: doSplice, run: () => void cart.value.items.splice(0, 1) });

      scoped(s, () => void first.value);
      runs = 0;

      await scoped(s, () => doSplice());
      expect(runs).toBe(1);
      expect(scoped(s, () => first.value)).toBe(2);
    });

    it("fires only the exact index path on a direct index assignment", async () => {
      const s = scope();
      const setZero = event<void>();
      const state = mutableStore({ items: [1, 2, 3] });
      const a0 = computed(() => state.value.items[0]);
      const a2 = computed(() => state.value.items[2]);
      let runsA = 0;
      let runsB = 0;
      reaction({ on: a0, run: () => void runsA++ });
      reaction({ on: a2, run: () => void runsB++ });
      reaction({ on: setZero, run: () => void (state.value.items[0] = 9) });

      scoped(s, () => {
        void a0.value;
        void a2.value;
      });
      runsA = 0;
      runsB = 0;

      await scoped(s, () => setZero());
      expect(runsA).toBe(1);
      expect(runsB).toBe(0);
      expect(scoped(s, () => [...state.value.items])).toEqual([9, 2, 3]);
    });
  });
});
