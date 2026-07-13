import { describe, expect, it } from "vitest";
import { computed, dependency, reaction, scope, scoped, store } from "../../lib";
import { flush } from "../support/store-helpers";

describe("computed", () => {
  describe("a scope-less observer of a computed that reads a dependency", () => {
    it("fires cross-scope once the dependency is provided in the firing scope", async () => {
      const dep = dependency<number>();
      const s = store(0);
      const c = computed(() => s.value + dep.value);
      const seen: number[] = [];
      reaction({ on: c, run: (v) => void seen.push(v as number) });

      const sc = scope({ deps: [[dep, 100]] });
      await scoped(sc, () => {
        s.value = 5;
      });
      await flush();

      expect(seen).toEqual([105]);
    });
  });

  describe("a scope-less observer of a conditional computed", () => {
    it("fires for a branch dependency once that branch is taken in a scope", async () => {
      const flag = store(false);
      const a = store(0);
      const c = computed(() => (flag.value ? a.value : -1));
      const seen: number[] = [];
      reaction({ on: c, run: (v) => void seen.push(v as number) });

      const sc = scope();
      await scoped(sc, () => {
        flag.value = true; // selector change -> c re-evaluates -> `a` becomes global
      });
      await scoped(sc, () => {
        a.value = 7; // now a change to `a` reaches the observer
      });
      await flush();

      expect(seen).toEqual([0, 7]);
    });
  });
});
