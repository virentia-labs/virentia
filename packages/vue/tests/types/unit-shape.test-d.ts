import { describe, expectTypeOf, it } from "vitest";
import type { EffectCallOptions, EventCallable, Effect, Reactive, Store } from "@virentia/core";
import type { Ref } from "vue";
import type { UnitShape } from "../../lib";

// ---------------------------------------------------------------------------
// UnitShape: tuple/record binding shapes used by useUnit overloads
// ---------------------------------------------------------------------------
describe("UnitShape", () => {
  it("maps a readonly tuple positionally to a tuple of UnitRef", () => {
    type Shape = UnitShape<readonly [Store<number>, EventCallable<string>]>;
    expectTypeOf<Shape[0]>().toEqualTypeOf<Readonly<Ref<number>>>();
    expectTypeOf<Shape[1]>().toEqualTypeOf<(payload: string) => Promise<void>>();
  });

  it("preserves tuple length/order for three-element tuples", () => {
    type Shape = UnitShape<readonly [Store<boolean>, Effect<number, string, unknown>, Reactive<{ x: 1 }>]>;
    expectTypeOf<Shape[0]>().toEqualTypeOf<Readonly<Ref<boolean>>>();
    expectTypeOf<Shape[1]>().toEqualTypeOf<(params: number, options?: EffectCallOptions) => Promise<string>>();
    expectTypeOf<Shape[2]>().toEqualTypeOf<Readonly<Ref<{ x: 1 }>>>();
  });

  it("maps a record to a record of UnitRef per key", () => {
    type Shape = UnitShape<{ a: Store<number>; go: EventCallable<void> }>;
    expectTypeOf<Shape["a"]>().toEqualTypeOf<Readonly<Ref<number>>>();
    expectTypeOf<Shape["go"]>().toEqualTypeOf<(payload?: void) => Promise<void>>();
  });

  // TODO(phase-2 dedup): overlaps "maps a record to a record of UnitRef per key"
  it("over a record yields refs and callables per key", () => {
    type Shape = UnitShape<{ a: Store<number>; go: EventCallable<void> }>;
    expectTypeOf<Shape["a"]>().toEqualTypeOf<Readonly<Ref<number>>>();
    expectTypeOf<Shape["go"]>().toEqualTypeOf<(payload?: void) => Promise<void>>();
  });

  it("resolves non tuple/record inputs to never", () => {
    expectTypeOf<UnitShape<string>>().toEqualTypeOf<never>();
    expectTypeOf<UnitShape<number>>().toEqualTypeOf<never>();
  });
});
