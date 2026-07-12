import { describe, expect, it } from "vitest";
import { scope, scoped } from "@virentia/core";
import { mutableStore, unwrap } from "../../lib";

describe("mutableStore", () => {
  describe("an owned node", () => {
    it("is mutated in place, keeping a stable unwrap identity across commits", () => {
      const state = mutableStore({ list: [] as number[] });
      const s = scope();

      scoped(s, () => state.value.list.push(1));
      const firstRef = scoped(s, () => unwrap(state.value.list));
      scoped(s, () => state.value.list.push(2));
      const secondRef = scoped(s, () => unwrap(state.value.list));

      expect([...secondRef]).toEqual([1, 2]);
      expect(secondRef).toBe(firstRef);
    });

    it("is observed changing mid-transaction before the commit boundary", () => {
      const state = mutableStore({ n: 0 });
      const s = scope();

      // First divergence copies-on-write and commits an owned object.
      scoped(s, () => {
        state.value.n = 1;
      });
      const committedRef = scoped(s, () => unwrap(state.value));

      // A later transaction mutates that same owned object in place BEFORE the
      // commit boundary — so the previously-committed reference is observed
      // changing mid-flight. This documents that pre-commit atomicity only holds
      // on the first divergence / a wholesale replace.
      scoped(s, () => {
        state.value.n = 5;
        expect((committedRef as { n: number }).n).toBe(5);
      });
    });
  });

  describe("an object assigned into the tree", () => {
    it("is never mutated", () => {
      const external = { k: 1 };
      const state = mutableStore({ ref: null as null | { k: number } });
      const s = scope();

      scoped(s, () => (state.value.ref = external));
      scoped(s, () => (state.value.ref!.k = 2));

      expect(external.k).toBe(1);
      expect(scoped(s, () => state.value.ref!.k)).toBe(2);
    });

    it("stores the raw underlying object when a draft proxy is assigned", () => {
      const state = mutableStore({ src: { k: 1 }, dst: null as null | { k: number } });
      const s = scope();

      scoped(s, () => {
        state.value.dst = state.value.src; // src read is a draft proxy; set unwraps it
      });

      scoped(s, () => {
        // The stored value is the raw object, not a nested proxy.
        expect(unwrap(state.value.dst)).toBe(unwrap(state.value.src));
      });
    });

  });
});
