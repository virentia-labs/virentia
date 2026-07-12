import { afterEach, describe, expect, it } from "vitest";
import { createEvent, createStore } from "effector";
import { effect, event, reaction, scoped } from "@virentia/core";
import { callAssociation } from "../../lib/runtime";
import type { VirentiaTarget } from "../../lib/types";
import { makeAssociation, resetAmbientScope } from "../support/effector-harness";

afterEach(resetAmbientScope);

describe("callAssociation()", () => {
  it("dispatches an effector target via allSettled in the association's effector scope", async () => {
    const { e, association } = makeAssociation();
    const $vals = createStore<number[]>([]);
    const target = createEvent<number>();
    $vals.on(target, (a, v) => [...a, v]);
    await callAssociation(association, target as any, 9);
    expect(e.getState($vals)).toEqual([9]);
  });

  it("dispatches a virentia-effect target via scoped and returns the effect result", async () => {
    const { association } = makeAssociation();
    const fx = effect(async (p: number) => p + 100);
    const ret = await callAssociation(association, fx as any, 5);
    expect(ret).toBe(105);
  });

  it("awaits runVirentia for a non-effect virentia target and resolves undefined", async () => {
    const { v, association } = makeAssociation();
    const target = event<number>();
    const seen: number[] = [];
    reaction({ on: target, run: (x) => seen.push(x) });
    const ret = await callAssociation(association, target as unknown as VirentiaTarget<number>, 3);
    expect(ret).toBeUndefined();
    expect(seen).toEqual([3]);
    // payload landed in the association's virentia scope
    scoped(v, () => {
      expect(seen).toEqual([3]);
    });
  });
});
