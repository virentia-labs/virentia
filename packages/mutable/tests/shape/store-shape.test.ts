import { describe, expect, it } from "vitest";
import { scope, scoped } from "@virentia/core";
import { mutableStore } from "../../lib";

describe("mutableStore", () => {
  describe("its shape", () => {
    it("exposes node, a writable flag, value, subscribe and map", () => {
      const state = mutableStore({ a: 1 });
      expect(typeof state.node).toBe("object");
      expect(state.writable).toBe(true);
      expect(typeof state.subscribe).toBe("function");
      expect(typeof state.map).toBe("function");
      // `value` is a getter/setter — descriptor lives on the object.
      const desc = Object.getOwnPropertyDescriptor(state, "value");
      expect(typeof desc?.get).toBe("function");
      expect(typeof desc?.set).toBe("function");
    });
  });

  describe("without an active scope", () => {
    it("throws when .value is read", () => {
      const state = mutableStore({ a: 1 });
      expect(() => state.value).toThrow(/read a mutable store/);
    });

    it("throws when .value is assigned", () => {
      const state = mutableStore({ a: 1 });
      expect(() => {
        state.value = { a: 2 };
      }).toThrow(/write a mutable store/);
    });

    it("throws when a mapped read is forced, but resolves inside a scope", () => {
      const state = mutableStore({ a: 1 });
      const doubled = state.map((v) => v.a * 2);
      // The computed reads the store, which requires a scope (the computed layer's
      // guard reports first, but it is still a scope-required failure).
      expect(() => scoped(scope(), () => doubled.value)).not.toThrow();
      expect(() => doubled.value).toThrow(/Scope is required/);
    });
  });
});
