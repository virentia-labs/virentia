import { describe, expect, it } from "vitest";
import { event, reaction, scope, scoped } from "../../lib";
import { flush } from "../support/store-helpers";

describe("event listeners", () => {
  describe("multiple listeners on one event", () => {
    it("deliver the payload to every listener in insertion order", async () => {
      const appScope = scope();
      const submitted = event<number>();
      const log: string[] = [];

      // Three listeners (explicit reactions) registered on the same event, in a
      // known order.
      reaction({ on: submitted, run: (value) => log.push(`a:${value}`) });
      reaction({ on: submitted, run: (value) => log.push(`b:${value}`) });
      reaction({ on: submitted, run: (value) => log.push(`c:${value}`) });

      await scoped(appScope, () => submitted(7));
      await flush();

      // A single fire delivers the same payload to all three, and they run in the
      // order they were registered — never interleaved or reordered.
      expect(log).toEqual(["a:7", "b:7", "c:7"]);
    });

    it("keep that order across successive fires", async () => {
      const appScope = scope();
      const submitted = event<number>();
      const log: string[] = [];

      reaction({ on: submitted, run: (value) => log.push(`a:${value}`) });
      reaction({ on: submitted, run: (value) => log.push(`b:${value}`) });

      await scoped(appScope, () => submitted(1));
      await scoped(appScope, () => submitted(2));
      await flush();

      expect(log).toEqual(["a:1", "b:1", "a:2", "b:2"]);
    });
  });
});
