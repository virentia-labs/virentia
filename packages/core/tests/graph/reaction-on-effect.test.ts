import { describe, expect, it } from "vitest";
import { effect, reaction, scope, scoped } from "../../lib";
import { flush } from "../support/store-helpers";

describe("reaction", () => {
  describe("on an effect", () => {
    it("delivers the effect's params to the body on each call", async () => {
      const fx = effect(async (n: number) => n * 2);
      const seen: number[] = [];
      const sc = scope();
      reaction({ scope: sc, on: fx, run: (params) => void seen.push(params as number) });

      await scoped(sc, () => fx(7));
      await flush();

      expect(seen).toEqual([7]);
    });

    it("still runs the effect handler, so the call is not skipped", async () => {
      let ran = 0;
      const fx = effect(async (n: number) => {
        ran += n;
      });
      const sc = scope();
      reaction({ scope: sc, on: fx, run: () => {} });

      await scoped(sc, () => fx(9));
      await flush();

      expect(ran).toBe(9);
    });
  });
});
