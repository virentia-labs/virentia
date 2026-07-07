import { describe, expect, it } from "vitest";
import { effect, event, reaction, scope, scoped, store } from "../lib";

describe("scoped awaits the work its body triggers", () => {
  it("waits for an async chain started by a unit", async () => {
    const appScope = scope();
    const submitted = event<number>();
    const doubleFx = effect(async (value: number) => {
      await Promise.resolve();
      return value * 2;
    });
    const values: number[] = [];

    submitted.node.next = [doubleFx.node];

    reaction({
      on: doubleFx.doneData,
      run: (value: number) => {
        values.push(value);
      },
    });

    await scoped(appScope, () => submitted(3));

    expect(values).toEqual([6]);
    scoped(appScope, () => {
      expect(doubleFx.pending.value).toBe(false);
      expect(doubleFx.inFlight.value).toBe(0);
    });
  });

  it("uses the current scope when triggered from scoped work", async () => {
    const appScope = scope();
    const submitted = event<number>();
    const value = store(0);

    reaction({
      on: submitted,
      run: (next: number) => {
        value.value = next;
      },
    });

    const publish = (next: number) => scoped(() => submitted(next));

    await scoped(appScope, () => publish(5));

    scoped(appScope, () => {
      expect(value.value).toBe(5);
    });
  });

  it("requires a scope when none is active", () => {
    const submitted = event<number>();

    expect(() => scoped(() => submitted(1))).toThrow("Scope is required");
  });
});
