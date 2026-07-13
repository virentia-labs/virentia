import { describe, expect, it } from "vitest";
import { computed, reaction, scope, scoped, store } from "../../lib";
import { flush } from "../support/store-helpers";

// Activating a computed for a scope-less observer must not make it fire
// spuriously: an unchanged recomputed value is still deduped, and a store that is
// NOT one of its dependencies must never reach it.
describe("computed", () => {
  describe("a scope-less observer", () => {
    it("does not fire again when a dependency change leaves the value unchanged", async () => {
      const s = store(1);
      const positive = computed(() => s.value > 0);
      const seen: boolean[] = [];
      reaction({ on: positive, run: (v) => void seen.push(v as boolean) });

      const sc = scope();
      await scoped(sc, () => {
        s.value = 2; // first observation in this scope -> establishes `true`
      });
      await flush();
      expect(seen).toEqual([true]);

      await scoped(sc, () => {
        s.value = 3; // still > 0 -> value unchanged, deduped
      });
      await flush();
      expect(seen).toEqual([true]);
    });

    it("does not fire on a change to a store it does not depend on", async () => {
      const s = store(0);
      const unrelated = store(0);
      const doubled = computed(() => s.value * 2);
      const seen: number[] = [];
      reaction({ on: doubled, run: (v) => void seen.push(v as number) });

      const sc = scope();
      await scoped(sc, () => {
        unrelated.value = 99;
      });
      await flush();
      expect(seen).toEqual([]); // unrelated is not a dependency

      await scoped(sc, () => {
        s.value = 4;
      });
      await flush();
      expect(seen).toEqual([8]);
    });
  });
});
