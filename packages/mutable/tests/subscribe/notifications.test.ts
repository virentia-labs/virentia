import { describe, expect, it } from "vitest";
import { event, reaction, scope, scoped, store } from "@virentia/core";
import type { Scope } from "@virentia/core";
import { mutableStore } from "../../lib";

describe("mutableStore", () => {
  describe("a subscriber", () => {
    it("stops receiving after it unsubscribes", () => {
      const state = mutableStore({ n: 0 });
      const s = scope();
      let calls = 0;
      const off = state.subscribe(() => calls++);
      scoped(s, () => (state.value.n = 1));
      off();
      scoped(s, () => (state.value.n = 2));
      expect(calls).toBe(1);
    });

    it("receives commits from two scopes with the right scope argument", () => {
      const state = mutableStore({ n: 0 });
      const x = scope();
      const y = scope();
      const seen: Array<[number, Scope]> = [];
      state.subscribe((v, sc) => seen.push([v.n, sc]));

      scoped(x, () => (state.value.n = 1));
      scoped(y, () => (state.value.n = 2));

      expect(seen).toEqual([
        [1, x],
        [2, y],
      ]);
    });

    it("produces a separate commit when it writes during a notification", () => {
      const state = mutableStore({ n: 0 });
      const s = scope();
      const seen: number[] = [];
      let guard = true;
      state.subscribe((v) => {
        seen.push(v.n);
        if (guard) {
          guard = false;
          scoped(s, () => (state.value.n += 100));
        }
      });

      scoped(s, () => (state.value.n = 1));
      expect(seen).toEqual([1, 101]);
      expect(scoped(s, () => state.value.n)).toBe(101);
    });

    it("is safe when it unsubscribes itself during a notification", () => {
      const state = mutableStore({ n: 0 });
      const s = scope();
      let aCalls = 0;
      let bCalls = 0;
      const offA = state.subscribe(() => {
        aCalls++;
        offA();
      });
      state.subscribe(() => bCalls++);

      expect(() => scoped(s, () => (state.value.n = 1))).not.toThrow();
      expect(aCalls).toBe(1);
      expect(bCalls).toBe(1);

      scoped(s, () => (state.value.n = 2));
      expect(aCalls).toBe(1); // A removed itself
      expect(bCalls).toBe(2);
    });

    it("notifies once per transaction across repeated events and drives a map", async () => {
      const s = scope();
      const bumped = event<void>();
      const state = mutableStore({ n: 0, other: 5 });
      const doubled = state.map((value) => value.n * 2);
      const seen: number[] = [];

      state.subscribe((value) => seen.push(value.n));

      reaction({
        on: bumped,
        run() {
          state.value.n += 1;
          state.value.other += 1;
        },
      });

      await scoped(s, () => bumped());
      await scoped(s, () => bumped());

      expect(scoped(s, () => doubled.value)).toBe(4);
      expect(seen).toEqual([1, 2]); // one notification per transaction (batched)
    });

    it("is notified with the real scope when the write happens inside an auto-reaction", async () => {
      const s = scope();
      const trigger = store(0);
      const state = mutableStore({ n: 0 });
      const seen: Array<[number, Scope]> = [];

      // An auto-reaction body runs with a per-run micro-scope as the ambient
      // scope; the mutation must still commit into (and notify with) the real
      // scope — a subscriber filtering by scope identity would drop it otherwise.
      reaction(() => {
        state.value.n = trigger.value;
      });

      state.subscribe((value, sc) => seen.push([value.n, sc]));

      await scoped(s, () => {
        trigger.value = 7;
      });

      expect(seen.map(([n]) => n)).toEqual([7]);
      // Identity, not deep equality: a micro-scope deep-equals its parent
      // (it shares the maps by reference), which is precisely the bug.
      expect(seen[0]?.[1]).toBe(s);
      expect(scoped(s, () => state.value.n)).toBe(7);
    });
  });
});
