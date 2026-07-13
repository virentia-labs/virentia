import { describe, expect, it } from "vitest";
import { reaction, scope, scoped, store } from "../../lib";
import { flush } from "../support/store-helpers";

describe("store", () => {
  describe("a subscriber that throws", () => {
    it("does not stop a sibling subscriber on the same store", () => {
      const s = store(0);
      const seen: number[] = [];
      s.subscribe(() => {
        throw new Error("boom");
      });
      s.subscribe((v) => seen.push(v));

      const sc = scope();
      expect(() =>
        scoped(sc, () => {
          s.value = 1;
        }),
      ).not.toThrow();
      expect(seen).toEqual([1]);
    });

    it("does not stop the store's own reactive propagation", async () => {
      const s = store(0);
      const reacted: number[] = [];
      const sc = scope();
      reaction({ scope: sc, on: s, run: (v) => void reacted.push(v as number) });
      s.subscribe(() => {
        throw new Error("boom");
      });
      reacted.length = 0; // drop the creation pass

      await scoped(sc, () => {
        s.value = 5;
      });
      await flush();

      expect(reacted).toEqual([5]);
    });
  });
});
