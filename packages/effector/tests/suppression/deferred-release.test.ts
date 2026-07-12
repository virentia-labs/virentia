import { afterEach, describe, expect, it } from "vitest";
import { event, reaction } from "@virentia/core";
import { shouldSkipVirentia, suppressVirentia } from "../../lib/association-state";
import { emitVirentia } from "../../lib/runtime";
import type { VirentiaTarget } from "../../lib/types";
import { deferred, flush, makeAssociation, resetAmbientScope } from "../support/effector-harness";

afterEach(resetAmbientScope);

describe("suppressVirentia release", () => {
  it("defers the release until runVirentia settles", async () => {
    const { association } = makeAssociation();
    const target = event<number>();
    const gate = deferred();
    reaction({
      on: target,
      run() {
        return gate.promise;
      },
    });

    emitVirentia(association, target as unknown as VirentiaTarget<number>, 1, {
      suppressReaction: true,
    });
    // synchronously suppressed, and stays suppressed while the async reaction runs.
    expect(shouldSkipVirentia(association, target as object)).toBe(true);
    await Promise.resolve();
    expect(shouldSkipVirentia(association, target as object)).toBe(true);

    gate.resolve();
    await flush();
    expect(shouldSkipVirentia(association, target as object)).toBe(false);
  });

  it("releases by decrement, so a double-invoked release clears a still-held counter (BUG)", () => {
    // Documents current behaviour: two overlapping holders share one counter, and a
    // double-invoked release drives it to zero, clearing suppression while a
    // legitimate holder is still outstanding. See suspected-bug note.
    const { association } = makeAssociation();
    const u = {};
    const release1 = suppressVirentia(association, u);
    const release2 = suppressVirentia(association, u);
    expect(shouldSkipVirentia(association, u)).toBe(true);
    release1();
    expect(shouldSkipVirentia(association, u)).toBe(true); // still held by release2's count
    release1(); // erroneous double-invoke
    // BUG: suppression cleared even though release2 was never called.
    expect(shouldSkipVirentia(association, u)).toBe(false);
    release2(); // no-op / underflow-safe (deletes an already-absent key)
    expect(shouldSkipVirentia(association, u)).toBe(false);
  });
});
