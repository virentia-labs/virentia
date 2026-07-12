import { describe, expect, it } from "vitest";
import { computed, event, reaction, scope, scoped } from "@virentia/core";
import { mutableStore } from "../../lib";

describe("mutableStore", () => {
  describe("keypath tracking", () => {
    it("invalidates a deep reader when an ancestor is replaced", async () => {
      const s = scope();
      const replaceA = event<void>();
      const doc = mutableStore({ a: { x: 0 } });
      const deep = computed(() => doc.value.a.x);
      let runs = 0;
      reaction({ on: deep, run: () => void runs++ });
      reaction({ on: replaceA, run: () => void (doc.value.a = { x: 5 }) });

      scoped(s, () => void deep.value);
      runs = 0;

      await scoped(s, () => replaceA());
      expect(runs).toBe(1);
      expect(scoped(s, () => deep.value)).toBe(5);
    });

    it("leaves a sibling path's reader untouched", async () => {
      const s = scope();
      const editA = event<void>();
      const doc = mutableStore({ a: { x: 0 }, b: { y: 0 } });
      const bv = computed(() => doc.value.b.y);
      let bRuns = 0;
      reaction({ on: bv, run: () => void bRuns++ });
      reaction({ on: editA, run: () => void (doc.value.a.x = 1) });

      scoped(s, () => void bv.value);
      bRuns = 0;

      await scoped(s, () => editA());
      expect(bRuns).toBe(0);
    });

    // A path that starts as an object node and becomes a primitive leaf in a later
    // transaction: the deep reader (of a.x) must re-run because it tracks the `a`
    // prefix, which the assignment `a = 5` fires.
    it("re-runs a reader that descended through a node when it becomes a leaf", async () => {
      const s = scope();
      const collapse = event<void>();
      const state = mutableStore({ a: { x: 1 } as { x: number } | number });
      const deep = computed(() => {
        const a = state.value.a;
        return typeof a === "object" ? a.x : a;
      });
      let runs = 0;
      reaction({ on: deep, run: () => void runs++ });
      reaction({ on: collapse, run: () => void (state.value.a = 5) });

      scoped(s, () => void deep.value);
      runs = 0;

      await scoped(s, () => collapse());
      expect(runs).toBe(1);
      expect(scoped(s, () => deep.value)).toBe(5);
    });

    // TODO(phase-2 dedup): overlaps "leaves a sibling path's reader untouched"
    // (was mutable.test.ts "subscribes computeds per keypath").
    it("does not re-run a computed whose keypath a sibling change never touched", async () => {
      const s = scope();
      const changeItems = event<void>();
      const changeCoupon = event<void>();
      const cart = mutableStore({ items: [] as number[], coupon: "" });

      const count = computed(() => cart.value.items.length);
      const coupon = computed(() => cart.value.coupon);

      let countRuns = 0;
      let couponRuns = 0;
      reaction({ on: count, run: () => void countRuns++ });
      reaction({ on: coupon, run: () => void couponRuns++ });

      reaction({ on: changeItems, run: () => void cart.value.items.push(1) });
      reaction({ on: changeCoupon, run: () => void (cart.value.coupon = "SALE") });

      // First read registers each computed's keypath dependencies.
      scoped(s, () => {
        void count.value;
        void coupon.value;
      });
      countRuns = 0;
      couponRuns = 0;

      await scoped(s, () => changeItems());
      expect(countRuns).toBe(1);
      expect(couponRuns).toBe(0); // `coupon` never read `items` → not re-run

      await scoped(s, () => changeCoupon());
      expect(couponRuns).toBe(1);
      expect(countRuns).toBe(1); // `count` never read `coupon` → still 1
    });

    // TODO(phase-2 dedup): overlaps "leaves a sibling path's reader untouched"
    // (was mutable.test.ts "keeps deep siblings independent").
    it("keeps deep siblings independent", async () => {
      const s = scope();
      const editA = event<void>();
      const doc = mutableStore({ a: { x: 0 }, b: { y: 0 } });

      const av = computed(() => doc.value.a.x);
      const bv = computed(() => doc.value.b.y);
      let aRuns = 0;
      let bRuns = 0;
      reaction({ on: av, run: () => void aRuns++ });
      reaction({ on: bv, run: () => void bRuns++ });
      reaction({ on: editA, run: () => void (doc.value.a.x = 1) });

      scoped(s, () => {
        void av.value;
        void bv.value;
      });
      aRuns = 0;
      bRuns = 0;

      await scoped(s, () => editA());
      expect(aRuns).toBe(1);
      expect(bRuns).toBe(0); // editing `a.x` leaves `b.y` readers alone
    });
  });

  describe("a deep mutation", () => {
    it("is reflected in a computed read within the same scope", () => {
      const s = scope();
      const state = mutableStore({ user: { name: "a", tags: ["x"] }, count: 0 });
      const count = computed(() => state.value.count);

      scoped(s, () => {
        expect(count.value).toBe(0);

        state.value.user.name = "b";
        state.value.user.tags.push("y");
        state.value.count += 1;

        expect(state.value.user).toEqual({ name: "b", tags: ["x", "y"] });
        expect(count.value).toBe(1);
      });
    });
  });
});
