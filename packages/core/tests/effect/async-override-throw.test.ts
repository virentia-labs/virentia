import { describe, expect, it } from "vitest";
import { effect, reaction, scope, scoped } from "../../lib";

describe("effect", () => {
  describe("async scope-override handler failure", () => {
    it("routes an async override handler's thrown error through the fail path", async () => {
      const boom = new Error("override boom");
      const fx = effect<number, string, Error>(async (value) => `real:${value}`);
      const overrideScope = scope({
        handlers: [
          [
            fx,
            async () => {
              throw boom;
            },
          ],
        ],
      });
      const events: unknown[] = [];

      reaction({ on: fx.doneData, run: (value) => events.push(["doneData", value]) });
      reaction({ on: fx.failed, run: (value) => events.push(["failed", value]) });
      reaction({ on: fx.failData, run: (value) => events.push(["failData", value]) });
      reaction({ on: fx.settled, run: (value) => events.push(["settled", value]) });

      await expect(scoped(overrideScope, () => fx(7))).rejects.toBe(boom);

      // The override's rejection — not the default handler's success — drives the
      // fail path; doneData never fires.
      expect(events).toEqual([
        ["failed", { params: 7, error: boom }],
        ["failData", boom],
        ["settled", { status: "fail", params: 7, error: boom }],
      ]);
      scoped(overrideScope, () => {
        expect(fx.pending.value).toBe(false);
        expect(fx.inFlight.value).toBe(0);
      });
    });

    it("routes an override handler that returns a rejecting promise through failData", async () => {
      const boom = new Error("rejected promise");
      const fx = effect<number, string, Error>(async (value) => `real:${value}`);
      const overrideScope = scope({
        handlers: [[fx, () => Promise.reject(boom)]],
      });
      const fails: unknown[] = [];

      reaction({ on: fx.failData, run: (value) => fails.push(value) });

      await expect(scoped(overrideScope, () => fx(3))).rejects.toBe(boom);
      expect(fails).toEqual([boom]);
      scoped(overrideScope, () => expect(fx.inFlight.value).toBe(0));
    });
  });
});
