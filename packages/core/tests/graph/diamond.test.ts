import { describe, expect, it } from "vitest";
import { computed, reaction, scope, scoped, store } from "../../lib";

// A diamond: a -> b, a -> c, (b, c) -> d. Both b and c derive from a, and d
// reads both. Glitch-freedom is NOT a contractual guarantee of virentia, so
// these tests CHARACTERIZE the actual behavior observed today: d is evaluated
// exactly once per change to a (not once per path), it never sees a mix of a
// stale and a fresh dependency, and the observer is notified once per change. A
// regression that reintroduced a glitch (double recompute, torn read, duplicate
// notification) would fail here.
describe("dependency graph", () => {
  describe("a diamond dependency", () => {
    it("evaluates the shared dependant exactly once when the shared source changes", () => {
      const sc = scope();
      const a = store(1);
      let dCalls = 0;
      const b = computed(() => a.value + 1);
      const c = computed(() => a.value * 2);
      const d = computed(() => {
        dCalls += 1;
        return b.value + c.value;
      });
      reaction({ scope: sc, run: () => void d.value });

      const afterCreate = dCalls;
      scoped(sc, () => {
        a.value = 10;
      });

      // One recompute for the single change to a — not one per diamond path.
      expect(dCalls - afterCreate).toBe(1);
    });

    it("never exposes a mix of a stale and a fresh dependency", () => {
      const sc = scope();
      const a = store(1);
      const seenPairs: Array<[number, number]> = [];
      const b = computed(() => a.value + 1);
      const c = computed(() => a.value * 2);
      const d = computed(() => {
        const bv = b.value;
        const cv = c.value;
        seenPairs.push([bv, cv]);
        return bv + cv;
      });
      reaction({ scope: sc, run: () => void d.value });

      scoped(sc, () => {
        a.value = 10;
      });
      scoped(sc, () => {
        a.value = 7;
      });

      // Every evaluation of d saw b and c derived from the SAME a (b = a+1,
      // c = a*2), so (b-1) must equal (c/2). A glitch that paired a fresh b with a
      // stale c (or vice-versa) would break this equality.
      for (const [bv, cv] of seenPairs) {
        expect(bv - 1).toBe(cv / 2);
      }
    });

    it("notifies the observer once per change to the shared source", () => {
      const sc = scope();
      const a = store(1);
      const b = computed(() => a.value + 1);
      const c = computed(() => a.value * 2);
      const d = computed(() => b.value + c.value);
      const seen: number[] = [];
      reaction({ scope: sc, run: () => seen.push(d.value) });

      scoped(sc, () => {
        a.value = 10; // b:11, c:20, d:31
      });
      scoped(sc, () => {
        a.value = 7; // b:8, c:14, d:22
      });

      // Initial run (4) + one notification per change. No duplicate from the two
      // diamond paths.
      expect(seen).toEqual([4, 31, 22]);
    });
  });
});
