import { describe, expect, it } from "vitest";
import { effect, scope, scoped } from "../../lib";
import { flush, never } from "../support/async-flush";

describe("effect", () => {
  describe("lifecycle store reads across scopes", () => {
    it("reads the initial false/0 from a scope the effect was never called in", async () => {
      const calledScope = scope();
      const neverCalledScope = scope();
      const fx = effect<number, string, unknown>(() => never<string>());

      scoped(calledScope, () => {
        void fx(1);
      });
      await flush();

      // The untouched scope reads the store defaults.
      scoped(neverCalledScope, () => {
        expect(fx.pending.value).toBe(false);
        expect(fx.inFlight.value).toBe(0);
      });
      // Sanity: the scope it ran in does report the transition.
      scoped(calledScope, () => {
        expect(fx.pending.value).toBe(true);
        expect(fx.inFlight.value).toBe(1);
      });
    });

    it("delivers scope-A pending transitions to a scope-less subscriber", async () => {
      const appScope = scope();
      let resolveFx!: (value: string) => void;
      const fx = effect<void, string, unknown>(
        () =>
          new Promise<string>((resolve) => {
            resolveFx = resolve;
          }),
      );
      const pendingValues: boolean[] = [];

      // Subscribed with no ambient scope — it still observes scope-A's writes.
      fx.pending.subscribe((next) => {
        pendingValues.push(next);
      });

      const call = scoped(appScope, () => fx());
      await flush();
      expect(pendingValues).toEqual([true]);

      resolveFx("ok");
      await call;
      await flush();

      expect(pendingValues).toEqual([true, false]);
    });
  });
});
