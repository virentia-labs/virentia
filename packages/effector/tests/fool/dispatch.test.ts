import { afterEach, describe, expect, it, vi } from "vitest";
import { createEvent, createStore } from "effector";
import { event, reaction, scoped } from "@virentia/core";
import { fool } from "../../lib";
import { flush, makeAssociation, resetAmbientScope } from "../support/effector-harness";

afterEach(resetAmbientScope);

describe("fool() dispatch", () => {
  it("dispatches a fooled virentia event to the original virentia event", async () => {
    const orig = event<number>();
    const seen: number[] = [];
    reaction({ on: orig, run: (v) => seen.push(v) });
    const f = fool(orig);
    const { v } = makeAssociation();
    await scoped(v, () => (f as unknown as (n: number) => unknown)(7));
    expect(seen).toEqual([7]);
  });

  it("routes a fooled effector event to the virentia adapter under a scope, raw effector otherwise", async () => {
    const f = fool(createEvent<number>());
    const seen: number[] = [];
    reaction({ on: f as any, run: (x) => seen.push(x as number) });
    const { v } = makeAssociation();

    // Scoped: goes through the virentia adapter -> virentia reaction observes it.
    await scoped(v, () => (f as unknown as (n: number) => unknown)(1));
    expect(seen).toEqual([1]);

    // Unscoped: dispatches the raw effector event (no active virentia scope), so the
    // virentia reaction does NOT observe it. The raw event fires with no scope, and
    // the bridge scope-node logs a missing-association error (swallowed by effector).
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      (f as unknown as (n: number) => unknown)(2);
      await flush();
    } finally {
      consoleError.mockRestore();
    }
    expect(seen).toEqual([1]);
  });

  it("throws when a fooled effector store is called outside a scope", () => {
    const s = fool(createStore(0));
    expect(() => (s as unknown as (n: number) => unknown)(5)).toThrow(
      "Effector store cannot be called",
    );
  });

  it("routes a fooled effector store called inside a scope into the virentia adapter", async () => {
    const s = fool(createStore(0));
    const seen: number[] = [];
    reaction({ on: s as any, run: (x) => seen.push(x as number) });
    const { v } = makeAssociation();
    await scoped(v, () => (s as unknown as (n: number) => unknown)(5));
    expect(seen).toEqual([5]);
  });
});
