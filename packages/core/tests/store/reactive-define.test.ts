import { describe, expect, it } from "vitest";
import { reactive, scope, scoped } from "../../lib";

describe("reactive", () => {
  describe("Object.defineProperty on a field", () => {
    it("throws instead of silently defining on the shared api object", () => {
      const r = reactive({ a: 1 });
      const sc = scope();
      expect(() =>
        scoped(sc, () => {
          Object.defineProperty(r, "b", { value: 2, enumerable: true, configurable: true });
        }),
      ).toThrow("defineProperty");
    });

    it("leaves the state untouched when the definition is rejected", () => {
      const r = reactive({ a: 1 });
      const sc = scope();
      try {
        scoped(sc, () => {
          Object.defineProperty(r, "b", { value: 2 });
        });
      } catch {
        // expected
      }
      scoped(sc, () => {
        expect("b" in r).toBe(false);
        expect(r.a).toBe(1);
      });
    });
  });
});
