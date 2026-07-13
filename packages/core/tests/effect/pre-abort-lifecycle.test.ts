import { describe, expect, it } from "vitest";
import { effect, reaction, scope, scoped } from "../../lib";
import { flush } from "../support/async-flush";

describe("effect", () => {
  describe("pre-aborted external signal", () => {
    it("pins the observed lifecycle for a call made with an already-aborted signal", async () => {
      const appScope = scope();
      const reason = new Error("pre-aborted");
      const controller = new AbortController();
      controller.abort(reason);
      let handlerRan = false;
      const fx = effect<number, string, unknown>(() => {
        handlerRan = true;
        return "should-not-run";
      });
      const events: unknown[] = [];

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

      // OBSERVED / PINNED lifecycle for a pre-aborted signal:
      //   the call still emits `started` (the counter goes up before the execute
      //   node sees the aborted signal), and `aborted` is emitted eagerly while the
      //   call is created — BEFORE `started` — followed by the fail trio. Both the
      //   abort channel and the fail channel fire, matching the mid-flight abort
      //   contract (aborted + failData). `done`/`doneData` never fire.
      expect(events).toEqual([
        ["aborted", { params: 9, reason }],
        ["started", 9],
        ["failed", { params: 9, error: reason }],
        ["failData", reason],
        ["settled", { status: "fail", params: 9, error: reason }],
      ]);

      scoped(appScope, () => {
        expect(fx.inFlight.value).toBe(0);
        expect(fx.pending.value).toBe(false);
      });
    });
  });
});
