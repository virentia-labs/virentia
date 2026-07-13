import { describe, expect, it } from "vitest";
import { computed, reaction, scope, scoped, store } from "../../lib";
import { flush } from "../support/store-helpers";

// A diamond: two computeds (`a`, `b`) read the same source and both feed a
// single `sum`. A scope-less observer of `sum` must fire GLITCH-FREE when the
// shared source changes — exactly once, with the fully-propagated value — even
// though both of `sum`'s inputs became dirty from a single write. A naive
// invalidation that pushes each input independently would recompute `sum` twice
// and surface an intermediate value.
describe("computed", () => {
  describe("a diamond under a scope-less observer", () => {
    it("fires exactly once with the final value when the shared source changes", async () => {
      const s = store(0);
      const a = computed(() => s.value + 1);
      const b = computed(() => s.value + 2);
      const sum = computed(() => a.value + b.value);
      const seen: number[] = [];
      reaction({ on: sum, run: (v) => void seen.push(v as number) });

      const sc = scope();
      await scoped(sc, () => {
        s.value = 10;
      });
      await flush();

      // s=10 -> a=11, b=12, sum=23. One coherent notification, never an
      // intermediate (e.g. 22 from a stale `b`) and never a duplicate.
      expect(seen).toEqual([23]);
    });
  });
});
