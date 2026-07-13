import { describe, expect, it } from "vitest";
import { effect, lazyModel, scope, scoped, store } from "../../lib";
import type { Effect } from "../../lib";

describe("lazyModel", () => {
  describe("a loader that reads scope state at its synchronous start", () => {
    it("resolves the read against the launching scope", async () => {
      const cfg = store(21);
      const model = lazyModel<{ answerFx: Effect<void, number, unknown> }>(async () => {
        const base = cfg.value * 2; // synchronous read -> needs the launching scope
        const answerFx = effect(async () => base);
        return { answerFx };
      });

      const sc = scope();
      // Calling a lazy method triggers the load and awaits it.
      const result = await scoped(sc, () => model.answerFx());

      expect(result).toBe(42);
    });
  });
});
