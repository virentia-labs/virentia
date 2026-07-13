import { describe, expect, it } from "vitest";
import { effect, reaction, scope, scoped } from "../../lib";
import { flush, never } from "../support/async-flush";

describe("effect", () => {
  describe("abort fan-out", () => {
    it("aborts every concurrent call in one scope, emitting aborted once per call and draining inFlight", async () => {
      const appScope = scope();
      const reason = new Error("stop all");
      const fx = effect<number, string, unknown>(() => never<string>());
      const abortedEvents: unknown[] = [];
      const rejections: unknown[] = [];

      reaction({ on: fx.aborted, run: (value) => abortedEvents.push(value) });

      let c1!: Promise<string>;
      let c2!: Promise<string>;
      scoped(appScope, () => {
        c1 = fx(1);
        c2 = fx(2);
      });
      c1.catch((error) => rejections.push(["c1", error]));
      c2.catch((error) => rejections.push(["c2", error]));
      await flush();

      // Both calls share the scope, so inFlight sums them.
      expect(scoped(appScope, () => fx.inFlight.value)).toBe(2);
      expect(scoped(appScope, () => fx.pending.value)).toBe(true);

      // A single scope-local abort cancels the whole fan-out.
      await scoped(appScope, () => fx.abort(reason));

      await expect(c1).rejects.toBe(reason);
      await expect(c2).rejects.toBe(reason);
      await flush();

      // Exactly one aborted event per in-flight call, each carrying its own
      // params, in activeCalls insertion order.
      expect(abortedEvents).toEqual([
        { params: 1, reason },
        { params: 2, reason },
      ]);
      expect(rejections).toEqual([
        ["c1", reason],
        ["c2", reason],
      ]);
      scoped(appScope, () => {
        expect(fx.inFlight.value).toBe(0);
        expect(fx.pending.value).toBe(false);
      });
    });
  });
});
