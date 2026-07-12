import { afterEach, describe, expect, it } from "vitest";
import { fork } from "effector";
import { scope } from "@virentia/core";
import { associate, effectorAssociations } from "../../lib";
import { resetAmbientScope } from "../support/effector-harness";

afterEach(resetAmbientScope);

describe("associate()", () => {
  describe("missing scope", () => {
    it("throws when the virentia scope is missing", () => {
      expect(() => associate({ effector: fork() } as any)).toThrow(
        "Effector association requires a Virentia scope",
      );
    });

    it("throws when the effector scope is missing", () => {
      expect(() => associate({ virentia: scope() } as any)).toThrow(
        "Effector association requires an Effector scope",
      );
    });
  });

  describe("registration", () => {
    it("registers the association in both WeakMaps", () => {
      const v = scope();
      const e = fork();
      const a = associate({ virentia: v, effector: e });
      expect(effectorAssociations.byVirentia.get(v)).toBe(a);
      expect(effectorAssociations.byEffector.get(e)).toBe(a);
      expect(a.virentia).toBe(v);
      expect(a.effector).toBe(e);
    });

    it("returns the same association object for the identical pair with both maps in sync", () => {
      const v = scope();
      const e = fork();
      const a = associate({ virentia: v, effector: e });
      const b = associate({ virentia: v, effector: e });
      expect(b).toBe(a);
      expect(effectorAssociations.byVirentia.get(v)).toBe(a);
      expect(effectorAssociations.byEffector.get(e)).toBe(a);
      expect(effectorAssociations.byVirentia.get(v)).toBe(effectorAssociations.byEffector.get(e));
    });

    it("reuses the existing association object when the identical pair is associated again", () => {
      // First register only virentia via effector e1, then associate the SAME virentia
      // with the same effector again — must reuse, not mint.
      const v = scope();
      const e = fork();
      const original = associate({ virentia: v, effector: e });
      // Force byEffector to be re-set through the "existing" branch by calling again.
      const again = associate({ virentia: v, effector: e });
      expect(again).toBe(original);
      expect(effectorAssociations.byVirentia.get(v)).toBe(original);
      expect(effectorAssociations.byEffector.get(e)).toBe(original);
    });
  });

  describe("re-binding a scope to a different counterpart", () => {
    it("rejects re-binding a virentia scope to a different effector scope", () => {
      const v = scope();
      associate({ virentia: v, effector: fork() });
      expect(() => associate({ virentia: v, effector: fork() })).toThrow(
        "Virentia scope is already associated with another Effector scope",
      );
    });

    it("rejects re-binding an effector scope to a different virentia scope", () => {
      const e = fork();
      associate({ virentia: scope(), effector: e });
      expect(() => associate({ virentia: scope(), effector: e })).toThrow(
        "Effector scope is already associated with another Virentia scope",
      );
    });
  });
});
