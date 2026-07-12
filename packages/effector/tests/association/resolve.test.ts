import { afterEach, describe, expect, it } from "vitest";
import { getCurrentScope, scoped } from "@virentia/core";
import {
  resolveAssociationFromEffectorScope,
  resolveAssociationFromVirentiaScope,
} from "../../lib/runtime";
import { makeAssociation, resetAmbientScope } from "../support/effector-harness";

afterEach(resetAmbientScope);

describe("resolveAssociationFromEffectorScope()", () => {
  it("throws instead of dereferencing when the effector scope is undefined or null", () => {
    expect(() => resolveAssociationFromEffectorScope(undefined)).toThrow(
      "Effector association is missing",
    );
    expect(() => resolveAssociationFromEffectorScope(null)).toThrow(
      "Effector association is missing",
    );
  });

  it("throws cross-scope contamination when an unrelated virentia scope is active", () => {
    const { e: eA } = makeAssociation();
    const { v: vB } = makeAssociation();
    scoped(vB, () => {
      expect(() => resolveAssociationFromEffectorScope(eA)).toThrow(
        "Effector scope is associated with another Virentia scope",
      );
    });
  });

  it("returns the association when there is no active virentia scope or it matches", () => {
    const { v, e, association } = makeAssociation();
    expect(resolveAssociationFromEffectorScope(e)).toBe(association);
    scoped(v, () => {
      expect(resolveAssociationFromEffectorScope(e)).toBe(association);
    });
  });
});

describe("resolveAssociationFromVirentiaScope()", () => {
  it("throws when no virentia scope is active", () => {
    expect(getCurrentScope()).toBeNull();
    expect(() => resolveAssociationFromVirentiaScope()).toThrow(
      "Effector association is missing",
    );
  });

  it("returns the current scope's association", () => {
    const { v, association } = makeAssociation();
    scoped(v, () => {
      expect(resolveAssociationFromVirentiaScope()).toBe(association);
    });
  });
});
