import { describe, expect, it, vi } from "vitest";
import { f, model, staticModel } from "@virentia/core/models";
import { component } from "../lib";
import { componentMetadataOf } from "../lib/component";

describe("native component definitions", () => {
  for (const define of [model, staticModel]) {
    it(`preserves the supplied ${define.name} instead of creating a hidden definition`, () => {
      const Model = define({ data: { label: f.string("hello") } });
      const view = vi.fn(() => "view");
      const First = component({ model: Model, view, keep: true });
      const Second = component({ model: Model, view });
      expect(First.model).toBe(Model);
      expect(Second.model).toBe(Model);
      expect(componentMetadataOf(First)).toMatchObject({ model: Model, view, keep: true });
      expect(componentMetadataOf(Second)?.keep).toBe(false);
      expect(view).not.toHaveBeenCalled();
    });
  }
  it("does not silently wrap plain helpers in staticModel", () => {
    expect(componentMetadataOf(() => "text")).toBeUndefined();
    expect(() => component((() => "old setup") as never)).toThrow("expects { model");
    expect(() => component({ model: {} as never, view: () => null })).toThrow("expects { model");
  });
});
