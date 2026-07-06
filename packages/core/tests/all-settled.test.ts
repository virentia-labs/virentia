import { describe, expect, it } from "vitest";
import { allSettled, createNode, effect, event, reaction, scope, scoped, store } from "../lib";

describe("allSettled", () => {
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

    await allSettled(submitted, { scope: appScope, payload: 3 });

    expect(values).toEqual([6]);
    scoped(appScope, () => {
      expect(doubleFx.pending.value).toBe(false);
      expect(doubleFx.inFlight.value).toBe(0);
    });
  });

  it("runs raw nodes in a provided scope", async () => {
    const appScope = scope();
    const value = store(0);
    const writeValue = createNode((ctx) => {
      value.value = ctx.value as number;
    });

    await allSettled(writeValue, { scope: appScope, payload: 4 });

    scoped(appScope, () => {
      expect(value.value).toBe(4);
    });
  });

  it("uses the current scope when called from scoped work", async () => {
    const appScope = scope();
    const submitted = event<number>();
    const value = store(0);

    reaction({
      on: submitted,
      run: (next: number) => {
        value.value = next;
      },
    });

    const publish = (next: number) => allSettled(submitted, { payload: next });

    await scoped(appScope, () => publish(5));

    scoped(appScope, () => {
      expect(value.value).toBe(5);
    });
  });

  it("requires a scope when no active scope exists", () => {
    const submitted = event<number>();

    expect(() => allSettled(submitted, { payload: 1 })).toThrow("Scope is required");
  });

  it("names the offending unit in the scope error", () => {
    const submitted = event<number>("published");

    expect(() => allSettled(submitted, { payload: 1 })).toThrow(
      /Scope is required to call event "published"/,
    );
  });
});
