import { describe, expect, it } from "vitest";
import { scope, scoped } from "@virentia/core";
import { mutableStore, seedMutableStore } from "../../lib";

describe("mutableStore", () => {
  describe("seeding", () => {
    it("reflects the seeded base and notifies on a later mutation", () => {
      const state = mutableStore({ count: 0 });
      const s = scope();
      seedMutableStore(s, state, { count: 42 });
      let calls = 0;
      state.subscribe(() => calls++);
      scoped(s, () => state.value.count++);
      expect(scoped(s, () => state.value.count)).toBe(43);
      expect(calls).toBe(1);
    });

    it("resets an existing base", () => {
      const state = mutableStore({ a: 1 });
      const s = scope();
      scoped(s, () => (state.value.a = 1)); // establish a committed base
      seedMutableStore(s, state, { a: 100 });
      expect(scoped(s, () => state.value.a)).toBe(100);
    });

    it("throws for a non-mutable store", () => {
      const s = scope();
      expect(() => seedMutableStore(s, {} as never, {} as never)).toThrow(
        /seedMutableStore: not a mutable store/,
      );
    });

    it("mutates a seeded object in place, visible on the caller", () => {
      const external = { count: 1 };
      const state = mutableStore({ count: 0 });
      const s = scope();
      seedMutableStore(s, state, external);
      scoped(s, () => (state.value.count = 5));
      expect(external.count).toBe(5); // owned → in place
    });

    it("gives each seeded scope its own owned base", () => {
      const state = mutableStore({ count: 0 });
      const x = scope();
      const y = scope();
      seedMutableStore(x, state, { count: 10 });
      seedMutableStore(y, state, { count: 20 });

      scoped(x, () => state.value.count++);

      expect(scoped(x, () => state.value.count)).toBe(11);
      expect(scoped(y, () => state.value.count)).toBe(20); // untouched by x
    });
  });
});
