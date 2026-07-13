import { describe, expect, it } from "vitest";
import { computed, scope, scoped, store } from "../../lib";
import { run } from "../../lib/internal";
import { flush } from "../support/store-helpers";

describe("a store subscription", () => {
  describe("its unsubscribe called twice", () => {
    it("is a safe no-op that never re-notifies", async () => {
      const sc = scope();
      const s = store(0);
      const seen: number[] = [];
      const unsubscribe = s.subscribe((value) => seen.push(value));

      await run({ unit: s.node, payload: 1, scope: sc });
      unsubscribe();
      expect(() => unsubscribe()).not.toThrow();
      await run({ unit: s.node, payload: 2, scope: sc });

      expect(seen).toEqual([1]);
    });
  });
});

describe("a computed subscription", () => {
  describe("its unsubscribe called twice", () => {
    it("is a safe no-op that never re-notifies", async () => {
      const sc = scope();
      const s = store(0);
      const doubled = computed(() => s.value * 2);
      const seen: number[] = [];

      scoped(sc, () => doubled.value); // prime the cache in sc
      const unsubscribe = doubled.subscribe((value) => seen.push(value));

      scoped(sc, () => {
        s.value = 1;
      });
      await flush();
      expect(seen).toEqual([2]);

      unsubscribe();
      expect(() => unsubscribe()).not.toThrow();

      scoped(sc, () => {
        s.value = 2;
      });
      await flush();

      expect(seen).toEqual([2]);
    });
  });
});
