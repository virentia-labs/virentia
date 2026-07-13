import { describe, expectTypeOf, it } from "vitest";
import type { EventCallable, Store } from "@virentia/core";
import type { Ref } from "vue";
import type { Bound } from "../../lib/types";

// ---------------------------------------------------------------------------
// Bound<T>: @@shape resolution used by useUnit / useModel (refs in Vue)
// ---------------------------------------------------------------------------

describe("Bound (@@shape)", () => {
  it("unwraps an object @@shape declaration to refs and callables", () => {
    type S = Bound<{
      readonly ["@@shape"]: { count: Store<number>; inc: EventCallable<void> };
    }>;
    expectTypeOf<S["count"]>().toEqualTypeOf<Readonly<Ref<number>>>();
    expectTypeOf<S["inc"]>().toEqualTypeOf<(payload?: void) => Promise<void>>();
  });

  it("unwraps the effector-style @@shape method form", () => {
    type S = Bound<{ readonly ["@@shape"]: () => { count: Store<number> } }>;
    expectTypeOf<S["count"]>().toEqualTypeOf<Readonly<Ref<number>>>();
  });

  it("resolves nested @@shape sources to any depth", () => {
    type Inner = { readonly ["@@shape"]: { value: Store<string> } };
    type S = Bound<{
      readonly ["@@shape"]: { counter: Inner; go: EventCallable<void> };
    }>;
    expectTypeOf<S["counter"]["value"]>().toEqualTypeOf<Readonly<Ref<string>>>();
    expectTypeOf<S["go"]>().toEqualTypeOf<(payload?: void) => Promise<void>>();
  });

  it("drops the @@shape marker key from a bound record", () => {
    type S = Bound<{ count: Store<number>; readonly ["@@shape"]: { count: Store<number> } }>;
    expectTypeOf<keyof S>().toEqualTypeOf<"count">();
  });
});
