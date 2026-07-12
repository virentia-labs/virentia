import { describe, expect, it } from "vitest";
import { event, reaction, scope, scoped } from "@virentia/core";
import { mutableStore } from "../../lib";

describe("mutableStore", () => {
  describe("map", () => {
    it("does not recompute on an unrelated commit", async () => {
      const s = scope();
      const push = event<void>();
      const cart = mutableStore({ items: [] as number[], coupon: "" });
      const coupon = cart.map((v) => v.coupon);
      let runs = 0;
      reaction({ on: coupon, run: () => void runs++ });
      reaction({ on: push, run: () => void cart.value.items.push(1) });

      scoped(s, () => void coupon.value);
      runs = 0;

      await scoped(s, () => push());
      expect(runs).toBe(0); // map only read `coupon`
    });

    it("recomputes and reflects the new value when its read path changes", async () => {
      const s = scope();
      const setCoupon = event<void>();
      const cart = mutableStore({ coupon: "" });
      const coupon = cart.map((v) => v.coupon.toUpperCase());
      reaction({ on: setCoupon, run: () => void (cart.value.coupon = "sale") });

      expect(scoped(s, () => coupon.value)).toBe("");
      await scoped(s, () => setCoupon());
      expect(scoped(s, () => coupon.value)).toBe("SALE");
    });

    it("stays granular to a nested read path", async () => {
      const s = scope();
      const editX = event<void>();
      const editSibling = event<void>();
      const state = mutableStore({ a: { x: 0 }, b: { y: 0 } });
      const ax = state.map((v) => v.a.x);
      let runs = 0;
      reaction({ on: ax, run: () => void runs++ });
      reaction({ on: editSibling, run: () => void (state.value.b.y = 1) });
      reaction({ on: editX, run: () => void (state.value.a.x = 1) });

      scoped(s, () => void ax.value);
      runs = 0;

      await scoped(s, () => editSibling());
      expect(runs).toBe(0); // sibling untouched

      await scoped(s, () => editX());
      expect(runs).toBe(1);
      expect(scoped(s, () => ax.value)).toBe(1);
    });
  });
});
