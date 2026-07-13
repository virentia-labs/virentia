import { describe, expect, it } from "vitest";
import { computed, reaction, scope, scoped, store } from "../../lib";
import { flush } from "../support/store-helpers";

// A SCOPED reaction (`reaction({ scope, on })`) is intentionally per-scope
// opt-in: unlike a scope-less reaction (which activates the computed globally so
// it fires in every scope its dependency changes in), a scoped reaction only
// observes the computed in scopes where the computed has actually been read. The
// first read in the scope establishes the per-scope dependency edge; until then
// a dependency change does NOT reach the reaction. This test pins that intended
// scoped contract.
describe("computed", () => {
  describe("a scoped reaction on a computed never read in its scope", () => {
    it("does not fire until the computed is first read in that scope (per-scope opt-in)", async () => {
      const s = store(0);
      const c = computed(() => s.value * 2);
      const sc = scope();
      const seen: number[] = [];
      reaction({ scope: sc, on: c, run: (v) => void seen.push(v as number) });

      // The computed was never read in `sc`, so no per-scope edge exists: a
      // dependency change in `sc` is silent for this scoped reaction.
      await scoped(sc, () => {
        s.value = 5;
      });
      await flush();
      expect(seen).toEqual([]);

      // Read the computed in `sc` to establish the per-scope edge, then a further
      // dependency change reaches the reaction.
      scoped(sc, () => {
        void c.value;
      });
      await scoped(sc, () => {
        s.value = 6;
      });
      await flush();
      expect(seen).toEqual([12]);
    });
  });
});
