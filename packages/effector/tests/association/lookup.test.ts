import { afterEach, describe, expect, it } from "vitest";
import { fork } from "effector";
import { scope } from "@virentia/core";
import { ensureAssociation } from "../../lib";
import { makeAssociation, resetAmbientScope } from "../support/effector-harness";

afterEach(resetAmbientScope);

describe("ensureAssociation()", () => {
  describe("no matching association", () => {
    it("throws the generic missing message for an empty lookup", () => {
      expect(() => ensureAssociation({})).toThrow(
        "Effector association is missing. Call associate",
      );
    });

    it("throws the effector-specific message for an unknown effector scope", () => {
      expect(() => ensureAssociation({ effector: fork() })).toThrow(
        "Effector association is missing for provided Effector scope",
      );
    });

    it("throws the virentia-specific message for an unknown virentia scope", () => {
      expect(() => ensureAssociation({ virentia: scope() })).toThrow(
        "Effector association is missing for provided Virentia scope",
      );
    });

    it("throws on a cross-axis mismatch where the two scopes belong to different associations", () => {
      const { v: v1, e: e1 } = makeAssociation();
      const { e: e2 } = makeAssociation();
      // v1 resolves on the virentia axis, but effector e2 belongs to a different association.
      expect(() => ensureAssociation({ virentia: v1, effector: e2 })).toThrow(
        "Effector association is missing",
      );
      // sanity: the matching lookup still works.
      expect(ensureAssociation({ virentia: v1, effector: e1 }).virentia).toBe(v1);
    });
  });

  describe("resolution order", () => {
    it("resolves on the virentia axis first and validates the effector matches", () => {
      const { v, e, association } = makeAssociation();
      expect(ensureAssociation({ virentia: v, effector: e })).toBe(association);
      expect(ensureAssociation({ virentia: v })).toBe(association);
      expect(ensureAssociation({ effector: e })).toBe(association);
    });
  });
});
