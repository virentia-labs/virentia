import { describe, expect, it } from "vitest";
import { computed, reaction, scope, scoped, store } from "../../lib";
import { flush } from "../support/store-helpers";

// A three-deep computed chain (x -> y -> z) observed by a scope-less reaction.
// A source change in a scope none of the links were ever read in must propagate
// all the way down and fire the reaction once with the fully-derived value.
describe("computed", () => {
  describe("a scope-less observer of a three-deep computed chain", () => {
    it("fires with the fully propagated value in a fresh scope", async () => {
      const s = store(0);
      const x = computed(() => s.value);
      const y = computed(() => x.value + 1);
      const z = computed(() => y.value + 1);
      const seen: number[] = [];
      reaction({ on: z, run: (v) => void seen.push(v as number) });

      const sc = scope();
      await scoped(sc, () => {
        s.value = 5;
      });
      await flush();

      // s=5 -> x=5 -> y=6 -> z=7. One notification with the settled value.
      expect(seen).toEqual([7]);
    });
  });
});
