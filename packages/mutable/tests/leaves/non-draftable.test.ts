import { describe, expect, it } from "vitest";
import { computed, event, reaction, scope, scoped } from "@virentia/core";
import { mutableStore, unwrap } from "../../lib";

describe("mutableStore", () => {
  describe("a non-draftable leaf", () => {
    it("keeps Map and class instances raw and replaces them wholesale", () => {
      const map0 = new Map<number, number>();
      class C {
        v = 1;
      }
      const state = mutableStore({ m: map0, tag: new C() });
      const s = scope();

      scoped(s, () => {
        expect(unwrap(state.value.m)).toBe(map0); // raw, not a proxy
        expect(state.value.tag).toBeInstanceOf(C);
        state.value.m = new Map([[1, 2]]);
      });

      scoped(s, () => {
        expect(state.value.m.get(1)).toBe(2);
        expect(unwrap(state.value.m)).not.toBe(map0);
      });
    });

    it("exposes a Set leaf as the real instance", () => {
      const state = mutableStore({ s: new Set([1]) });
      const s = scope();
      scoped(s, () => {
        expect(state.value.s.has(1)).toBe(true);
        expect(state.value.s).toBeInstanceOf(Set);
        // The leaf is not a draft proxy: unwrap is an identity here.
        expect(unwrap(state.value.s)).toBe(state.value.s);
      });
    });

    it("contaminates the initial and does not notify when a Date leaf is mutated in place", async () => {
      const initial = { when: new Date(0) };
      const state = mutableStore(initial);
      const x = scope();
      const y = scope();
      const bump = event<void>();

      const whenTime = computed(() => state.value.when.getTime());
      let runs = 0;
      reaction({ on: whenTime, run: () => void runs++ });
      reaction({ on: bump, run: () => void state.value.when.setTime(5) });

      scoped(x, () => void whenTime.value);
      runs = 0;

      await scoped(x, () => bump());

      // The shared base Date was mutated in place — contaminating `initial`.
      expect(initial.when.getTime()).toBe(5);
      // Another scope sees the contamination too (shared base object).
      expect(scoped(y, () => state.value.when.getTime())).toBe(5);
      // No onChange fired for an in-place leaf mutation → no reactive re-run.
      expect(runs).toBe(0);
    });

    it("replaces a Date leaf wholesale", () => {
      const s = scope();
      const state = mutableStore({ when: new Date(0) });

      scoped(s, () => {
        state.value.when = new Date(1000);
        expect(state.value.when.getTime()).toBe(1000);
      });
    });
  });
});
