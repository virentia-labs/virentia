import { describe, expect, it } from "vitest";
import { computed, scope, scoped } from "../../lib";

describe("computed", () => {
  describe("a cycle", () => {
    it("throws on each read while it references itself", () => {
      const sc = scope();
      let c: { value: number };
      c = computed(() => (c.value ?? 0) + 1) as unknown as { value: number };

      scoped(sc, () => {
        expect(() => c.value).toThrow("Computed cycle detected");
        // The computing flag is reset in finally, so a second read throws cleanly
        // rather than wedging.
        expect(() => c.value).toThrow("Computed cycle detected");
      });
    });

    it("clears its guard so a later valid read succeeds", () => {
      const sc = scope();
      let first = true;
      let c: { value: number };
      c = computed(() => {
        if (first) {
          first = false;
          return c.value; // self read -> cycle on the first evaluation
        }
        return 42;
      }) as unknown as { value: number };

      scoped(sc, () => {
        expect(() => c.value).toThrow("Computed cycle detected");
        expect(c.value).toBe(42);
      });
    });
  });
});
