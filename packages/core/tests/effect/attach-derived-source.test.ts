import { describe, expect, it } from "vitest";
import { attach, computed, scope, scoped, store } from "../../lib";

describe("attach", () => {
  describe("derived (computed) source", () => {
    it("snapshots a computed source per scope at execute time", async () => {
      const a = scope();
      const b = scope();
      const base = store(1);
      const doubled = computed(() => base.value * 2);
      const readFx = attach({
        source: doubled,
        effect: (src: number, params: number) => src + params,
      });

      scoped(a, () => {
        base.value = 10;
      });
      scoped(b, () => {
        base.value = 100;
      });

      // Each call reads the computed in its own scope: 10*2+1 vs 100*2+1.
      await expect(scoped(a, () => readFx(1))).resolves.toBe(21);
      await expect(scoped(b, () => readFx(1))).resolves.toBe(201);
    });

    it("reads a nested computed source in the scope of the call", async () => {
      const a = scope();
      const b = scope();
      const base = store(2);
      const doubled = computed(() => base.value * 2);
      const plusOne = computed(() => doubled.value + 1);
      const readFx = attach({
        source: plusOne,
        effect: (src: number) => src,
      });

      scoped(a, () => {
        base.value = 3;
      });
      scoped(b, () => {
        base.value = 5;
      });

      // a: (3*2)+1 = 7 ; b: (5*2)+1 = 11
      await expect(scoped(a, () => readFx(0))).resolves.toBe(7);
      await expect(scoped(b, () => readFx(0))).resolves.toBe(11);
    });

    it("captures the source value at each call's execute time, not at declaration", async () => {
      const s = scope();
      const base = store(1);
      const view = computed(() => base.value + 1);
      const seen: number[] = [];
      const captureFx = attach({
        source: view,
        effect: async (src: number) => {
          seen.push(src);
          return src;
        },
      });

      const first = await scoped(s, () => captureFx(0));
      scoped(s, () => {
        base.value = 5;
      });
      const second = await scoped(s, () => captureFx(0));

      expect(first).toBe(2); // base 1 -> view 2
      expect(second).toBe(6); // base 5 -> view 6
      expect(seen).toEqual([2, 6]);
    });
  });
});
