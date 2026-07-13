import { describe, expect, it } from "vitest";
import { computed, reaction, scope, scoped } from "../../lib";

// A self-referential computed is a cycle. Attaching a scope-less reaction
// activates the computed globally (discovering deps through a wrapped, throw-
// swallowing bootstrap), but that observer path must NOT mask the cycle: a real
// read of the computed in a scope must still throw the cycle error to the reader.
describe("computed", () => {
  describe("a cycle observed by a scope-less reaction", () => {
    it("still throws the cycle error when read in a scope", () => {
      let c: { value: number };
      c = computed(() => (c.value ?? 0) + 1) as unknown as { value: number };

      // Registering the scope-less observer must not throw (the bootstrap
      // swallows the cycle during dependency discovery).
      const seen: number[] = [];
      reaction({ on: c, run: (v: any) => void seen.push(v as number) });

      const sc = scope();
      scoped(sc, () => {
        expect(() => c.value).toThrow("Computed cycle detected");
        // Guard is cleared in `finally`, so a repeat read throws cleanly too.
        expect(() => c.value).toThrow("Computed cycle detected");
      });

      // The cycle never produced a value, so the observer saw nothing.
      expect(seen).toEqual([]);
    });
  });
});
