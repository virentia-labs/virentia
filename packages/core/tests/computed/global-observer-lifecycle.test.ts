import { describe, expect, it } from "vitest";
import { computed, reaction, scope, scoped, store } from "../../lib";
import { flush } from "../support/store-helpers";

describe("computed", () => {
  describe("a scope-less subscription on a computed", () => {
    it("stops receiving cross-scope notifications after it unsubscribes", async () => {
      const s = store(0);
      const c = computed(() => s.value * 2);
      const seen: number[] = [];
      const off = c.subscribe((value) => seen.push(value));

      const a = scope();
      await scoped(a, () => {
        s.value = 3;
      });
      await flush();
      expect(seen).toEqual([6]);

      off();

      const b = scope();
      await scoped(b, () => {
        s.value = 4;
      });
      await flush();
      expect(seen).toEqual([6]);
    });

    it("fires multiple subscribers in insertion order across a scope change", async () => {
      const s = store(0);
      const c = computed(() => s.value + 1);
      const order: string[] = [];
      c.subscribe((value) => order.push(`A:${value}`));
      c.subscribe((value) => order.push(`B:${value}`));

      const sc = scope();
      await scoped(sc, () => {
        s.value = 1;
      });
      await flush();

      expect(order).toEqual(["A:2", "B:2"]);
    });

    it("activates even when the computed was already read in another scope", async () => {
      const s = store(0);
      const c = computed(() => s.value * 2);
      const a = scope();
      scoped(a, () => void c.value); // establishes a per-scope edge in `a` first

      const seen: number[] = [];
      c.subscribe((value) => seen.push(value));

      const b = scope();
      await scoped(b, () => {
        s.value = 5; // `b` never read `c`
      });
      await flush();

      expect(seen).toEqual([10]);
    });
  });

  describe("a scope-less reaction on a computed", () => {
    it("stops firing after it is stopped", async () => {
      const s = store(0);
      const c = computed(() => s.value * 2);
      const seen: number[] = [];
      const r = reaction({ on: c, run: (v) => void seen.push(v as number) });

      const sc = scope();
      await scoped(sc, () => {
        s.value = 3;
      });
      await flush();
      expect(seen).toEqual([6]);

      r.stop();

      await scoped(sc, () => {
        s.value = 4;
      });
      await flush();
      expect(seen).toEqual([6]);
    });
  });
});
