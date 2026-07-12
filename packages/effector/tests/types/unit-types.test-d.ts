import { describe, expectTypeOf, it } from "vitest";
import type {
  Unit as EffectorUnit,
  UnitTargetable as EffectorUnitTargetable,
} from "effector";
import type * as virentia from "@virentia/core";
import type { VirentiaTarget, VirentiaUnit } from "../../lib";
import type { BridgeTarget, BridgeUnit } from "../../lib/internal-types";

describe("VirentiaUnit / VirentiaTarget", () => {
  it("VirentiaUnit<T> is the five-member virentia unit union", () => {
    expectTypeOf<VirentiaUnit<number>>().toEqualTypeOf<
      | virentia.Event<number>
      | virentia.EventCallable<number>
      | virentia.Effect<number, any, any>
      | virentia.Store<number>
      | virentia.StoreWritable<number>
    >();
  });

  it("VirentiaUnit default parameter is unknown", () => {
    expectTypeOf<VirentiaUnit>().toEqualTypeOf<VirentiaUnit<unknown>>();
  });

  it("VirentiaTarget<T> is the three writable/callable targets", () => {
    expectTypeOf<VirentiaTarget<number>>().toEqualTypeOf<
      | virentia.EventCallable<number>
      | virentia.Effect<number, any, any>
      | virentia.StoreWritable<number>
    >();
  });

  it("VirentiaTarget default parameter is unknown", () => {
    expectTypeOf<VirentiaTarget>().toEqualTypeOf<VirentiaTarget<unknown>>();
  });

  it("no member of the union collapses to `any` or leaks `never`", () => {
    expectTypeOf<VirentiaUnit<number>>().not.toBeAny();
    expectTypeOf<VirentiaUnit<number>>().not.toBeNever();
    expectTypeOf<VirentiaUnit<any>>().not.toBeAny();
    expectTypeOf<VirentiaUnit<any>>().not.toBeNever();
    expectTypeOf<VirentiaTarget<never>>().not.toBeNever();
  });

  it("every VirentiaTarget is a VirentiaUnit but not vice-versa", () => {
    expectTypeOf<VirentiaTarget<number>>().toMatchTypeOf<VirentiaUnit<number>>();
    expectTypeOf<VirentiaUnit<number>>().not.toMatchTypeOf<VirentiaTarget<number>>();
  });
});

describe("internal bridge types (BridgeUnit / BridgeTarget)", () => {
  it("BridgeUnit<T> unions the effector and virentia unit worlds", () => {
    expectTypeOf<BridgeUnit<number>>().toEqualTypeOf<
      EffectorUnit<number> | EffectorUnitTargetable<number> | VirentiaUnit<number>
    >();
  });

  it("BridgeTarget<T> unions the effector and virentia target worlds", () => {
    expectTypeOf<BridgeTarget<number>>().toEqualTypeOf<
      EffectorUnitTargetable<number> | VirentiaTarget<number>
    >();
  });

  it("BridgeUnit default parameter is any, BridgeTarget default is unknown", () => {
    expectTypeOf<BridgeUnit>().toEqualTypeOf<BridgeUnit<any>>();
    expectTypeOf<BridgeTarget>().toEqualTypeOf<BridgeTarget<unknown>>();
    // Whole-union defaults must not collapse to `any` or `never`.
    expectTypeOf<BridgeUnit>().not.toBeAny();
    expectTypeOf<BridgeUnit>().not.toBeNever();
    expectTypeOf<BridgeTarget>().not.toBeNever();
  });
});
