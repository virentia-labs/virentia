import { describe, expect, it } from "vitest";
import { computed, event, reaction, scope, scoped } from "@virentia/core";
import { mutableStore, unwrap } from "../../lib";

describe("mutableStore", () => {
  describe("scope isolation", () => {
    it("hides a divergence from another scope and shares the untouched default", () => {
      const initial = { a: { v: 1 }, b: { v: 2 } };
      const state = mutableStore(initial);
      const x = scope();
      const y = scope();
      scoped(x, () => (state.value.a.v = 10));
      expect(scoped(y, () => state.value.a.v)).toBe(1);
      expect(scoped(x, () => unwrap(state.value.b))).toBe(initial.b);
      expect(scoped(y, () => unwrap(state.value.b))).toBe(initial.b);
    });

    it("keeps a commit in one scope from changing a reader's value in another", async () => {
      const push = event<void>();
      const cart = mutableStore({ items: [] as number[] });
      const count = computed(() => cart.value.items.length);
      const x = scope();
      const y = scope();

      reaction({ on: push, run: () => void cart.value.items.push(1) });

      // Register the computed's deps in both scopes.
      expect(scoped(x, () => count.value)).toBe(0);
      expect(scoped(y, () => count.value)).toBe(0);

      await scoped(x, () => push());

      // x diverged; y still sees the untouched default (scope-parameterized run).
      expect(scoped(x, () => count.value)).toBe(1);
      expect(scoped(y, () => count.value)).toBe(0);
    });
  });
});
