import { describe, expect, it } from "vitest";
import { effect, reaction, scope, scoped } from "../../lib";
import { flush } from "../support/async-flush";

describe("effect", () => {
  describe("pre-aborted external signal", () => {
    it("emits only aborted and the fail channel, never started", async () => {
      const appScope = scope();
      const reason = new Error("pre-aborted");
      const controller = new AbortController();
      controller.abort(reason);
      let handlerRan = false;
      const fx = effect<number, string, unknown>(() => {
        handlerRan = true;
        return "should-not-run";
      });
      const events: [string, unknown][] = [];

      reaction({ on: fx.started, run: (value) => events.push(["started", value]) });
      reaction({ on: fx.aborted, run: (value) => events.push(["aborted", value]) });
      reaction({ on: fx.failed, run: (value) => events.push(["failed", value]) });
      reaction({ on: fx.failData, run: (value) => events.push(["failData", value]) });
      reaction({ on: fx.doneData, run: (value) => events.push(["doneData", value]) });
      reaction({ on: fx.settled, run: (value) => events.push(["settled", value]) });

      const call = scoped(appScope, () => fx(9, { signal: controller.signal }));

      await expect(call).rejects.toBe(reason);
      await flush();

      // The handler never runs; the call rejects with the signal's reason.
      expect(handlerRan).toBe(false);

      // A call whose signal was already aborted before it ran never starts:
      // `aborted` fires (eagerly, as the call is created), then the fail channel
      // (failed / failData / settled). `started`, `done`, and `doneData` never fire.
      expect(events).toEqual([
        ["aborted", { params: 9, reason }],
        ["failed", { params: 9, error: reason }],
        ["failData", reason],
        ["settled", { status: "fail", params: 9, error: reason }],
      ]);
      expect(events.some(([kind]) => kind === "started")).toBe(false);

      scoped(appScope, () => {
        expect(fx.inFlight.value).toBe(0);
        expect(fx.pending.value).toBe(false);
      });
    });
  });
});
