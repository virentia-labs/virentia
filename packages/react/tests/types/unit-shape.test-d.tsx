import { describe, expectTypeOf, it } from "vitest";
import type { Effect, EventCallable, Store } from "@virentia/core";
import type { UnitShape } from "../../lib/types";

// ---------------------------------------------------------------------------
// UnitShape<Shape>
// ---------------------------------------------------------------------------

describe("UnitShape", () => {
  it("maps a tuple positionally to per-element UnitValue", () => {
    type S = UnitShape<readonly [Store<number>, EventCallable<string>]>;
    expectTypeOf<S>().toEqualTypeOf<readonly [number, (payload: string) => Promise<void>]>();
    expectTypeOf<S[0]>().toEqualTypeOf<number>();
    expectTypeOf<S[1]>().toEqualTypeOf<(payload: string) => Promise<void>>();
  });

  it("maps a record to per-key UnitValue (keeping keys)", () => {
    type S = UnitShape<{ count: Store<number>; done: EventCallable<void>; fx: Effect<string, boolean, unknown> }>;
    expectTypeOf<S["count"]>().toEqualTypeOf<number>();
    expectTypeOf<S["done"]>().toEqualTypeOf<(payload?: void) => Promise<void>>();
    expectTypeOf<S["fx"]>().parameter(0).toEqualTypeOf<string>();
    expectTypeOf<S["fx"]>().returns.toEqualTypeOf<Promise<boolean>>();
  });

  it("resolves to never for a non-tuple, non-record shape", () => {
    expectTypeOf<UnitShape<number>>().toBeNever();
    expectTypeOf<UnitShape<string>>().toBeNever();
    expectTypeOf<UnitShape<boolean>>().toBeNever();
  });

  it("maps the empty tuple to the empty tuple", () => {
    expectTypeOf<UnitShape<readonly []>>().toEqualTypeOf<readonly []>();
  });

  // TODO(phase-2 dedup): overlaps "maps a tuple positionally to per-element UnitValue"
  it("maps a tuple positionally per element (smoke)", () => {
    type S = UnitShape<readonly [Store<number>, EventCallable<string>]>;
    expectTypeOf<S[0]>().toEqualTypeOf<number>();
    expectTypeOf<S[1]>().toEqualTypeOf<(payload: string) => Promise<void>>();
  });
});
