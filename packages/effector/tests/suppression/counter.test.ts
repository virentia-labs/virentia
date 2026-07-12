import { afterEach, describe, expect, it } from "vitest";
import { shouldSkipEffector, shouldSkipVirentia, suppressEffector } from "../../lib/association-state";
import { makeAssociation, resetAmbientScope } from "../support/effector-harness";

afterEach(resetAmbientScope);

describe("suppression counter", () => {
  it("reports no skip when there is no active suppression", () => {
    const { association } = makeAssociation();
    const u = {};
    expect(shouldSkipEffector(association, u)).toBe(false);
    expect(shouldSkipVirentia(association, u)).toBe(false);
  });

  it("decrements suppressEffector in finally even when the callback throws", () => {
    const { association } = makeAssociation();
    const u = {};
    let inner = false;
    expect(() =>
      suppressEffector(association, u, () => {
        inner = shouldSkipEffector(association, u);
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(inner).toBe(true);
    expect(shouldSkipEffector(association, u)).toBe(false);
  });

  it("keeps nested suppression active until every level releases", () => {
    const { association } = makeAssociation();
    const u = {};
    const probes: boolean[] = [];
    suppressEffector(association, u, () => {
      probes.push(shouldSkipEffector(association, u)); // true (depth 1)
      suppressEffector(association, u, () => {
        probes.push(shouldSkipEffector(association, u)); // true (depth 2)
      });
      probes.push(shouldSkipEffector(association, u)); // true (back to depth 1)
    });
    probes.push(shouldSkipEffector(association, u)); // false (fully released)
    expect(probes).toEqual([true, true, true, false]);
  });

  it("leaves a different unit unsuppressed while unit A is suppressed", () => {
    const { association } = makeAssociation();
    const a = {};
    const b = {};
    suppressEffector(association, a, () => {
      expect(shouldSkipEffector(association, a)).toBe(true);
      expect(shouldSkipEffector(association, b)).toBe(false);
    });
  });

  it("isolates suppression per association", () => {
    const { association: a1 } = makeAssociation();
    const { association: a2 } = makeAssociation();
    const u = {};
    suppressEffector(a1, u, () => {
      expect(shouldSkipEffector(a1, u)).toBe(true);
      expect(shouldSkipEffector(a2, u)).toBe(false);
    });
  });
});
