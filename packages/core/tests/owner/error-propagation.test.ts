import { describe, expect, it } from "vitest";
import { onCleanup, owner } from "../../lib";

describe("owner", () => {
  describe("when the body throws and a rescue cleanup also throws", () => {
    it("surfaces the body's error, not the cleanup's", () => {
      expect(() =>
        owner(() => {
          onCleanup(() => {
            throw new Error("cleanup-error");
          });
          throw new Error("fn-error");
        }),
      ).toThrow("fn-error");
    });
  });
});
