import { describe, expect, it } from "vitest";
import { scope, scoped } from "@virentia/core";
import { mutableStore, unwrap } from "../../lib";

describe("mutableStore", () => {
  describe("unwrap", () => {
    it("passes primitives, null and plain objects through unchanged", () => {
      const o = { k: 1 };
      expect(unwrap(5)).toBe(5);
      expect(unwrap(null)).toBe(null);
      expect(unwrap("x")).toBe("x");
      expect(unwrap(undefined)).toBe(undefined);
      expect(unwrap(o)).toBe(o);
    });

    it("returns the latest underlying object of a draft proxy", () => {
      const state = mutableStore({ a: { x: 1 } });
      const s = scope();
      scoped(s, () => {
        const raw = unwrap(state.value.a);
        expect(raw).toEqual({ x: 1 });
        state.value.a.x = 2; // copy-on-write; raw was the pre-write base
        const raw2 = unwrap(state.value.a);
        expect(raw2.x).toBe(2);
      });
    });

    it("stores the raw object when one branch's proxy is assigned to another", () => {
      const state = mutableStore({ a: { k: 1 }, b: null as null | { k: number } });
      const s = scope();
      scoped(s, () => (state.value.b = state.value.a)); // b gets unwrap(a)
      scoped(s, () => (state.value.b!.k = 9)); // COW copies b off the shared object
      scoped(s, () => {
        expect(state.value.a.k).toBe(1);
        expect(state.value.b!.k).toBe(9);
      });
    });

    it("reads back null after a branch is cleared", () => {
      const state = mutableStore({ child: { k: 1 } as { k: number } | null });
      const s = scope();
      scoped(s, () => (state.value.child = null));
      scoped(s, () => {
        expect(state.value.child).toBeNull();
        expect(unwrap(state.value.child)).toBeNull();
      });
    });
  });
});
