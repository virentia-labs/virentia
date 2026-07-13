import { describe, expect, it } from "vitest";
import { computed, reaction, scope, scoped, store } from "../../lib";
import { flush } from "../support/store-helpers";

// A globally-observed computed dedups by `Object.is` on the produced value. For
// object results that hinges entirely on reference identity: a computed that
// builds a FRESH object on every evaluation re-fires on each change (references
// always differ), while one that returns a STABLE cached reference dedups a
// change that leaves the reference untouched.
describe("computed", () => {
  describe("a scope-less observer of a computed returning a fresh object each eval", () => {
    it("re-fires on every dependency change", async () => {
      const s = store(0);
      const c = computed(() => ({ v: s.value }));
      const seen: { v: number }[] = [];
      reaction({ on: c, run: (v) => void seen.push(v as { v: number }) });

      const sc = scope();
      await scoped(sc, () => {
        s.value = 1;
      });
      await flush();
      await scoped(sc, () => {
        s.value = 2;
      });
      await flush();

      expect(seen).toEqual([{ v: 1 }, { v: 2 }]);
    });
  });

  describe("a scope-less observer of a computed returning a stable cached reference", () => {
    it("dedups a change that leaves the reference unchanged", async () => {
      const s = store(0);
      const stable = { label: "constant" };
      // Reads `s` (so changes reach it) but always returns the same reference.
      const c = computed(() => {
        void s.value;
        return stable;
      });
      const seen: { label: string }[] = [];
      reaction({ on: c, run: (v) => void seen.push(v as { label: string }) });

      const sc = scope();
      await scoped(sc, () => {
        s.value = 1; // first observation -> emits `stable` once
      });
      await flush();
      expect(seen).toEqual([stable]);

      await scoped(sc, () => {
        s.value = 2; // recomputes but same reference -> Object.is dedups
      });
      await flush();
      expect(seen).toEqual([stable]);
      expect(seen).toHaveLength(1);
      expect(seen[0]).toBe(stable);
    });
  });
});
