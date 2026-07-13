import { describe, expect, it } from "vitest";
import { computed, reaction, scope, scoped, store } from "../../lib";
import { flush } from "../support/store-helpers";

describe("computed", () => {
  describe("a scope-less reaction on a computed", () => {
    it("fires when a dependency changes in a scope the computed was never read in", async () => {
      const s = store(0);
      const c = computed(() => s.value * 2);
      const seen: number[] = [];
      reaction({ on: c, run: (v) => void seen.push(v as number) });

      const sc = scope();
      await scoped(sc, () => {
        s.value = 5;
      });
      await flush();

      expect(seen).toEqual([10]);
    });

    it("fires in every scope its dependency changes in", async () => {
      const s = store(0);
      const c = computed(() => s.value + 1);
      const seen: number[] = [];
      reaction({ on: c, run: (v) => void seen.push(v as number) });

      const a = scope();
      const b = scope();
      await scoped(a, () => {
        s.value = 1;
      });
      await scoped(b, () => {
        s.value = 2;
      });
      await flush();

      expect([...seen].sort()).toEqual([2, 3]);
    });

    it("fires for a computed one level deep (computed of a computed)", async () => {
      const s = store(0);
      const doubled = computed(() => s.value * 2);
      const plusOne = computed(() => doubled.value + 1);
      const seen: number[] = [];
      reaction({ on: plusOne, run: (v) => void seen.push(v as number) });

      const sc = scope();
      await scoped(sc, () => {
        s.value = 5;
      });
      await flush();

      expect(seen).toEqual([11]); // 5*2 + 1
    });
  });

  describe("a scope-less subscription on a computed", () => {
    it("fires when a dependency changes in a scope the computed was never read in", async () => {
      const s = store(0);
      const c = computed(() => s.value * 2);
      const seen: number[] = [];
      c.subscribe((value) => seen.push(value));

      const sc = scope();
      await scoped(sc, () => {
        s.value = 5;
      });
      await flush();

      expect(seen).toEqual([10]);
    });

    it("delivers the scope each change happened in", async () => {
      const s = store(0);
      const c = computed(() => s.value + 1);
      const seen: [number, unknown][] = [];
      c.subscribe((value, changedScope) => seen.push([value, changedScope]));

      const a = scope();
      const b = scope();
      await scoped(a, () => {
        s.value = 1;
      });
      await scoped(b, () => {
        s.value = 2;
      });
      await flush();

      expect(seen).toEqual([
        [2, a],
        [3, b],
      ]);
    });
  });
});
