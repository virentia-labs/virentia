import { describe, expect, it } from "vitest";
import { event, reaction, scope, scoped } from "@virentia/core";
import { mutableStore } from "../../lib";

describe("mutableStore", () => {
  describe("batching", () => {
    it("coalesces many mutations in one reaction into a single commit", async () => {
      const s = scope();
      const go = event<void>();
      const state = mutableStore({ n: 0, other: 0 });
      let calls = 0;
      state.subscribe(() => calls++);
      reaction({
        on: go,
        run() {
          state.value.n++;
          state.value.n++;
          state.value.n++;
          state.value.n++;
          state.value.n++;
          state.value.other++;
          state.value.other++;
        },
      });

      await scoped(s, () => go());
      expect(calls).toBe(1); // single finalize
      expect(scoped(s, () => state.value.n)).toBe(5);
      expect(scoped(s, () => state.value.other)).toBe(2);
    });

    it("commits a plain scoped mutation at the scope boundary", () => {
      const s = scope();
      const state = mutableStore({ a: 0 });
      let calls = 0;
      state.subscribe(() => calls++);
      scoped(s, () => {
        state.value.a = 1;
      });
      expect(calls).toBe(1);
    });

    it("neither commits nor notifies for a pure read scope", () => {
      const s = scope();
      const state = mutableStore({ a: 0 });
      let calls = 0;
      state.subscribe(() => calls++);
      scoped(s, () => void state.value.a);
      expect(calls).toBe(0);
      // Committed still falls back to the initial value.
      expect(scoped(s, () => state.value.a)).toBe(0);
    });

    it("settles a batched reaction plus a reentrant subscriber write deterministically", async () => {
      const s = scope();
      const go = event<void>();
      const state = mutableStore({ n: 0 });
      const seen: number[] = [];
      let guard = true;
      state.subscribe((v) => {
        seen.push(v.n);
        if (guard) {
          guard = false;
          scoped(s, () => (state.value.n += 100));
        }
      });
      reaction({
        on: go,
        run() {
          state.value.n = 1;
          state.value.n = 2;
        },
      });

      await scoped(s, () => go());
      // The batched reaction commits once (n=2); the subscriber's reentrant write is
      // a separate commit (n=102). Ordering is deterministic.
      expect(seen).toEqual([2, 102]);
      expect(scoped(s, () => state.value.n)).toBe(102);
    });
  });

  describe("write-then-read in one transaction", () => {
    it("reads the new value and shape after a delete then re-add", () => {
      const state = mutableStore({ obj: { a: 1 } as Record<string, number> });
      const s = scope();
      scoped(s, () => {
        delete state.value.obj.a;
        expect("a" in state.value.obj).toBe(false);
        state.value.obj.a = 7;
        expect(state.value.obj.a).toBe(7);
        expect(Object.keys(state.value.obj)).toEqual(["a"]);
      });
      scoped(s, () => expect(state.value.obj.a).toBe(7));
    });

    it("reads the pending write on the same path", () => {
      const state = mutableStore({ a: { x: 1 } });
      const s = scope();
      scoped(s, () => {
        state.value.a.x = 42;
        expect(state.value.a.x).toBe(42);
        state.value.a.x = state.value.a.x + 1;
        expect(state.value.a.x).toBe(43);
      });
    });
  });
});
