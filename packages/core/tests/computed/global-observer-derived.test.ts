import { describe, expect, it } from "vitest";
import { computed, reaction, scope, scoped, store } from "../../lib";
import { flush } from "../support/store-helpers";

// A scope-less observer of a DERIVED store (map/filter of a computed) must fire
// in every scope its ultimate dependency changes in — not only where the derived
// store was already read. The derived link is static/global, but the raw computed
// underneath discovers its dependency lazily and per-scope, so this exercises the
// transitive activation of a whole chain.
describe("computed", () => {
  describe("a scope-less observer of a derived store", () => {
    it("fires for a mapped computed in a scope it was never read in", async () => {
      const s = store(0);
      const doubled = computed(() => s.value).map((v) => v * 2);
      const seen: number[] = [];
      reaction({ on: doubled, run: (v) => void seen.push(v as number) });

      const sc = scope();
      await scoped(sc, () => {
        s.value = 5;
      });
      await flush();

      expect(seen).toEqual([10]);
    });

    it("respects the predicate of a filtered computed across scopes", async () => {
      const s = store(0);
      const evens = computed(() => s.value).filter((v) => v % 2 === 0);
      const seen: number[] = [];
      reaction({ on: evens, run: (v) => void seen.push(v as number) });

      const sc = scope();
      await scoped(sc, () => {
        s.value = 4; // even -> passes
      });
      await scoped(sc, () => {
        s.value = 5; // odd -> filtered out
      });
      await scoped(sc, () => {
        s.value = 6; // even -> passes
      });
      await flush();

      expect(seen).toEqual([4, 6]);
    });

    it("fires through a map-then-filter chain in a fresh scope", async () => {
      const s = store(0);
      const big = computed(() => s.value)
        .map((v) => v * 2)
        .filter((v) => v > 5);
      const seen: number[] = [];
      reaction({ on: big, run: (v) => void seen.push(v as number) });

      const sc = scope();
      await scoped(sc, () => {
        s.value = 2; // *2 = 4, not > 5 -> filtered out
      });
      await scoped(sc, () => {
        s.value = 3; // *2 = 6, > 5 -> passes
      });
      await flush();

      expect(seen).toEqual([6]);
    });

    it("delivers to a subscription on a mapped computed across scopes", async () => {
      const s = store(0);
      const doubled = computed(() => s.value).map((v) => v * 2);
      const seen: number[] = [];
      doubled.subscribe((value) => seen.push(value));

      const sc = scope();
      await scoped(sc, () => {
        s.value = 7;
      });
      await flush();

      expect(seen).toEqual([14]);
    });
  });
});
