import { describe, expectTypeOf, it } from "vitest";
import type { Unit as EffectorUnit } from "effector";
import type * as virentia from "@virentia/core";
import { isEffectorUnit, isObjectLike, isVirentiaEffect, isVirentiaUnit } from "../../lib/guards";
import type { VirentiaUnit } from "../../lib";

describe("guards — `is`-narrowing return types", () => {
  it("isEffectorUnit narrows unknown -> EffectorUnit<any>", () => {
    expectTypeOf(isEffectorUnit).guards.toEqualTypeOf<EffectorUnit<any>>();
    expectTypeOf(isEffectorUnit).parameter(0).toEqualTypeOf<unknown>();
    const value: unknown = undefined;
    if (isEffectorUnit(value)) {
      expectTypeOf(value).toEqualTypeOf<EffectorUnit<any>>();
    }
  });

  it("isVirentiaUnit narrows unknown -> VirentiaUnit<any>", () => {
    expectTypeOf(isVirentiaUnit).guards.toEqualTypeOf<VirentiaUnit<any>>();
    const value: unknown = undefined;
    if (isVirentiaUnit(value)) {
      expectTypeOf(value).toEqualTypeOf<VirentiaUnit<any>>();
    }
  });

  it("isVirentiaEffect narrows unknown -> virentia.Effect<any, any, any>", () => {
    expectTypeOf(isVirentiaEffect).guards.toEqualTypeOf<virentia.Effect<any, any, any>>();
    const value: unknown = undefined;
    if (isVirentiaEffect(value)) {
      expectTypeOf(value).toEqualTypeOf<virentia.Effect<any, any, any>>();
      // narrowed guard is a proper VirentiaUnit member
      expectTypeOf(value).toMatchTypeOf<VirentiaUnit<any>>();
    }
  });

  it("isObjectLike narrows unknown -> object", () => {
    expectTypeOf(isObjectLike).guards.toEqualTypeOf<object>();
    const value: unknown = undefined;
    if (isObjectLike(value)) {
      expectTypeOf(value).toEqualTypeOf<object>();
    }
  });

  it("guard predicates are none-narrowing to never on the true branch", () => {
    expectTypeOf(isEffectorUnit).guards.not.toBeNever();
    expectTypeOf(isVirentiaUnit).guards.not.toBeNever();
    expectTypeOf(isVirentiaEffect).guards.not.toBeNever();
    expectTypeOf(isObjectLike).guards.not.toBeNever();
  });
});
