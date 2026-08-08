import { describe, expect, it } from "vitest";
import { effect, event, scope, scoped } from "../../lib";
import { status } from "../../lib/utils";
import { makeGates } from "../support/graph-helpers";
import { flush, readValue } from "../support/store-helpers";

describe("status", () => {
  it("walks initial → pending → done", async () => {
    const s = scope();
    const gates = makeGates();
    const fx = effect(async () => {
      await gates.wait();
      return "ok";
    });
    const $status = status(fx);

    expect(readValue(s, $status)).toBe("initial");

    const call = scoped(s, () => fx());

    expect(readValue(s, $status)).toBe("pending");

    gates.release(0);
    await call;
    await flush();

    expect(readValue(s, $status)).toBe("done");
  });

  it("a rejection lands in fail", async () => {
    const s = scope();
    const fx = effect(async () => {
      throw new Error("boom");
    });
    const $status = status(fx);

    await expect(scoped(s, () => fx())).rejects.toThrow("boom");
    await flush();

    expect(readValue(s, $status)).toBe("fail");
  });

  it("reset returns the machine to initial", async () => {
    const s = scope();
    const clear = event<void>();
    const fx = effect(async () => "ok");
    const $status = status(fx, { reset: clear });

    await scoped(s, () => fx());
    await flush();
    expect(readValue(s, $status)).toBe("done");

    await scoped(s, () => clear());
    expect(readValue(s, $status)).toBe("initial");
  });
});
