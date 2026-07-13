import { describe, expectTypeOf, it } from "vitest";
import type { EventCallable, Store } from "@virentia/core";
import type { Bound } from "../../lib/types";

// ---------------------------------------------------------------------------
// Bound<T>: @@shape resolution used by useUnit / useModel
// ---------------------------------------------------------------------------

describe("Bound (@@shape)", () => {
  it("unwraps an object @@shape declaration to bound values", () => {
    type S = Bound<{
      readonly ["@@shape"]: { count: Store<number>; inc: EventCallable<void> };
    }>;
    expectTypeOf<S["count"]>().toEqualTypeOf<number>();
    expectTypeOf<S["inc"]>().toEqualTypeOf<(payload?: void) => Promise<void>>();
  });

  it("unwraps the effector-style @@shape method form", () => {
    type S = Bound<{ readonly ["@@shape"]: () => { count: Store<number> } }>;
    expectTypeOf<S["count"]>().toEqualTypeOf<number>();
  });

  it("resolves nested @@shape sources to any depth", () => {
    type Inner = { readonly ["@@shape"]: { value: Store<string> } };
    type S = Bound<{
      readonly ["@@shape"]: { counter: Inner; go: EventCallable<void> };
    }>;
    expectTypeOf<S["counter"]["value"]>().toEqualTypeOf<string>();
    expectTypeOf<S["go"]>().toEqualTypeOf<(payload?: void) => Promise<void>>();
  });

  it("drops the @@shape marker key from a bound record", () => {
    type S = Bound<{ count: Store<number>; readonly ["@@shape"]: { count: Store<number> } }>;
    // The marker never survives as a field of the resolved shape.
    expectTypeOf<keyof S>().toEqualTypeOf<"count">();
  });
});
