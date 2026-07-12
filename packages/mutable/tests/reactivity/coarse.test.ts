import { describe, expect, it } from "vitest";
import { computed, event, reaction, scope, scoped } from "@virentia/core";
import { mutableStore, unwrap } from "../../lib";

describe("mutableStore", () => {
  describe("coarse dependencies", () => {
    it("re-runs an unwrap of a subtree on any store change", async () => {
      const s = scope();
      const bumpB = event<void>();
      const state = mutableStore({ a: { x: 0 }, b: 0 });
      // Returns a fresh object each eval so the downstream reaction fires on every
      // recompute — letting us observe the coarse (over-)subscription directly.
      const c = computed(() => ({ x: unwrap(state.value.a).x }));
      let runs = 0;
      reaction({ on: c, run: () => void runs++ });
      reaction({ on: bumpB, run: () => void (state.value.b += 1) });

      scoped(s, () => void c.value);
      runs = 0;

      await scoped(s, () => bumpB());
      // Even though `c` only unwrapped subtree `a`, unwrap → onReadAll → storeNode,
      // so the unrelated `b` commit re-runs it.
      expect(runs).toBe(1);
    });

    it("re-runs every live path reader on a wholesale replace, even now-absent paths", async () => {
      const s = scope();
      const replace = event<void>();
      const state = mutableStore({ a: 1, b: 2 } as { a: number; b?: number });
      const av = computed(() => state.value.a);
      const bv = computed(() => state.value.b);
      let aRuns = 0;
      let bRuns = 0;
      reaction({ on: av, run: () => void aRuns++ });
      reaction({ on: bv, run: () => void bRuns++ });
      reaction({ on: replace, run: () => void (state.value = { a: 9 }) });

      scoped(s, () => {
        void av.value;
        void bv.value;
      });
      aRuns = 0;
      bRuns = 0;

      await scoped(s, () => replace());
      expect(aRuns).toBe(1);
      expect(bRuns).toBe(1); // b path fired even though b is absent in the new value
      expect(scoped(s, () => state.value.a)).toBe(9);
      expect(scoped(s, () => state.value.b)).toBeUndefined();
    });

    it("fires only subscribers when a never-read path changes", async () => {
      const s = scope();
      const bumpB = event<void>();
      const state = mutableStore({ a: 0, b: 0 });
      // A fine reader of `a` only; nobody ever read `b`.
      const av = computed(() => state.value.a);
      let aRuns = 0;
      let subCalls = 0;
      reaction({ on: av, run: () => void aRuns++ });
      reaction({ on: bumpB, run: () => void (state.value.b += 1) });
      state.subscribe(() => subCalls++);

      scoped(s, () => void av.value);
      aRuns = 0;

      await scoped(s, () => bumpB());
      expect(subCalls).toBe(1); // coarse subscriber fires
      expect(aRuns).toBe(0); // the `a` reader is untouched by a `b` change
    });

    // kept: unwraps the whole store value (root); the partner unwraps a subtree,
    // a distinct scenario.
    it("re-runs an unwrap of the whole value on any change", async () => {
      const s = scope();
      const bump = event<void>();
      const state = mutableStore({ a: 0, b: 0 });

      const whole = computed(() => {
        const v = unwrap(state.value);
        return v.a + v.b;
      });
      let runs = 0;
      reaction({ on: whole, run: () => void runs++ });
      reaction({ on: bump, run: () => void (state.value.b += 1) });

      scoped(s, () => void whole.value);
      runs = 0;

      await scoped(s, () => bump());
      expect(runs).toBe(1); // unwrap reads the whole value, so any change re-runs it
    });
  });
});
