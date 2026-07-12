import { describe, expect, it } from "vitest";
import { event, reaction, scope, scoped } from "@virentia/core";
import { mutableStore } from "../../lib";

describe("mutableStore", () => {
  describe("atomic commit", () => {
    it("commits a replace followed by mutations as one combined result", async () => {
      const s = scope();
      const go = event<void>();
      const state = mutableStore({ a: 0, b: 0 });
      const seen: Array<{ a: number; b: number }> = [];
      state.subscribe((v) => seen.push({ ...v }));
      reaction({
        on: go,
        run() {
          state.value = { a: 1, b: 1 };
          state.value.a = 2;
        },
      });

      await scoped(s, () => go());
      expect(seen).toEqual([{ a: 2, b: 1 }]);
    });

    it("does not mutate the replacement source on a later in-draft write", () => {
      const next = { a: 0 };
      const state = mutableStore({ a: 5 });
      const s = scope();
      scoped(s, () => {
        state.value = next;
        state.value.a = 7;
      });
      expect(next.a).toBe(0); // copy-on-write on the replacement
      expect(scoped(s, () => state.value.a)).toBe(7);
    });

    it("keeps the last replace within one transaction", async () => {
      const s = scope();
      const go = event<void>();
      const state = mutableStore({ a: 0 });
      let calls = 0;
      state.subscribe(() => calls++);
      reaction({
        on: go,
        run() {
          state.value = { a: 1 };
          state.value = { a: 2 };
          state.value.a += 10;
        },
      });

      await scoped(s, () => go());
      expect(calls).toBe(1);
      expect(scoped(s, () => state.value.a)).toBe(12);
    });

    it("opens a fresh draft over the new tree after a replace", () => {
      const state = mutableStore({ a: { b: { c: 1 } } });
      const s = scope();
      scoped(s, () => {
        state.value = { a: { b: { c: 42 } } };
        expect(state.value.a.b.c).toBe(42);
      });
      scoped(s, () => expect(state.value.a.b.c).toBe(42));
    });

    it("replaces the whole value through the setter", () => {
      const s = scope();
      const state = mutableStore({ a: 1 });

      scoped(s, () => {
        state.value = { a: 99 };
        expect(state.value.a).toBe(99);
      });
    });

    // TODO(phase-2 dedup): overlaps "commits a replace followed by mutations as one
    // combined result" (was mutable.test.ts "defers a replace + mutation").
    it("defers a replace plus mutation to a single atomic commit inside a reaction", async () => {
      const s = scope();
      const go = event<void>();
      const state = mutableStore({ a: 0, b: 0 });
      const seen: Array<{ a: number; b: number }> = [];

      state.subscribe((value) => seen.push({ ...value }));

      reaction({
        on: go,
        run() {
          state.value = { a: 1, b: 1 }; // wholesale replace
          state.value.a = 2; // then mutate the replacement
        },
      });

      await scoped(s, () => go());

      // One notification with the combined result — nothing was committed early.
      expect(seen).toEqual([{ a: 2, b: 1 }]);
      expect(scoped(s, () => ({ a: state.value.a, b: state.value.b }))).toEqual({ a: 2, b: 1 });
    });
  });
});
