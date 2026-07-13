import { describe, expect, it } from "vitest";
import { computed, reaction, scope, scoped, store } from "../../lib";
import { flush } from "../support/store-helpers";

// `filterMap(fn, skipToken)` maps each value and, when the mapper returns the
// skip token, suppresses the emission and RETAINS the prior value for that
// scope. Under a scope-less observer this must hold per scope: a skipped change
// in one scope keeps that scope's last emitted value (so a later real change
// there is measured against it), while a change in a different, independent
// scope emits normally.
describe("computed", () => {
  describe("a scope-less observer of a filterMap with a skip token", () => {
    it("retains the prior value on a skip in one scope and emits in another", async () => {
      const SKIP = -1;
      const s = store(0);
      // Even source values map to value*10; odd values are skipped.
      const mapped = computed(() => s.value).filterMap(
        (v) => (v % 2 === 0 ? v * 10 : SKIP),
        SKIP,
      );
      const seen: number[] = [];
      reaction({ on: mapped, run: (v) => void seen.push(v as number) });

      const a = scope();
      const b = scope();

      await scoped(a, () => {
        s.value = 2; // even -> emits 20
      });
      await flush();
      expect(seen).toEqual([20]);

      await scoped(a, () => {
        s.value = 3; // odd -> skipped, scope `a` retains 20 (no emission)
      });
      await flush();
      expect(seen).toEqual([20]);

      await scoped(b, () => {
        s.value = 4; // independent scope, even -> emits 40
      });
      await flush();
      expect(seen).toEqual([20, 40]);

      await scoped(a, () => {
        s.value = 6; // even again; `a`'s retained prior was 20 -> 60 differs -> emits
      });
      await flush();
      expect(seen).toEqual([20, 40, 60]);
    });
  });
});
