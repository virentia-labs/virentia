import { afterEach, describe, expect, it } from "vitest";
import { createEvent } from "effector";
import { event } from "@virentia/core";
import { fool } from "../../lib";
import { resetAmbientScope } from "../support/effector-harness";

afterEach(resetAmbientScope);

describe("fool()", () => {
  describe("invalid input", () => {
    it("throws for a primitive, null, or undefined argument", () => {
      expect(() => fool(42 as any)).toThrow("fool() expects an Effector or Virentia unit");
      expect(() => fool(null as any)).toThrow("fool() expects an Effector or Virentia unit");
      expect(() => fool(undefined as any)).toThrow("fool() expects an Effector or Virentia unit");
      expect(() => fool("x" as any)).toThrow("fool() expects an Effector or Virentia unit");
    });

    it("throws for an object that is neither an effector unit nor a virentia unit", () => {
      expect(() => fool({ foo: 1 } as any)).toThrow("fool() expects an Effector or Virentia unit");
      expect(() => fool((() => {}) as any)).toThrow("fool() expects an Effector or Virentia unit");
    });
  });

  describe("caching", () => {
    it("returns the same fooled object for the same original unit", () => {
      const e = createEvent<number>();
      expect(fool(e)).toBe(fool(e));
      const v = event<number>();
      expect(fool(v)).toBe(fool(v));
    });

    it("returns an already-fooled unit unchanged", () => {
      const f = fool(event<number>());
      expect(fool(f as any)).toBe(f);
      const fe = fool(createEvent<number>());
      expect(fool(fe as any)).toBe(fe);
    });
  });

  describe("callable shape", () => {
    it("keeps the base callable's empty name and zero length while exposing a node", () => {
      const f = fool(createEvent<number>());
      expect(typeof f).toBe("function");
      // base callable is `(...args) => call(...args)` => length 0, empty name; copy skips them.
      expect((f as unknown as (...a: unknown[]) => unknown).length).toBe(0);
      expect((f as { name: string }).name).toBe("");
      expect("node" in (f as object)).toBe(true);
    });

    it("marks the fooled unit with a non-enumerable own symbol", () => {
      const f = fool(event<number>());
      const symbols = Object.getOwnPropertySymbols(f);
      const marker = symbols.find((s) => String(s) === "Symbol(virentia.effector.fooledUnit)");
      expect(marker).toBeDefined();
      const desc = Object.getOwnPropertyDescriptor(f, marker as symbol)!;
      expect(desc.enumerable).toBe(false);
      expect(desc.value).toBe(true);
      // never leaks into normal enumeration
      expect(Object.keys(f)).not.toContain(String(marker));
    });
  });
});
