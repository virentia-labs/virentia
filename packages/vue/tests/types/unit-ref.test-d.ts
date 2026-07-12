import { describe, expectTypeOf, it } from "vitest";
import { effect, event, reactive, store } from "@virentia/core";
import type {
  Effect,
  EffectCallOptions,
  EventCallable,
  Reactive,
  ReactiveWritable,
  Store,
  StoreWritable,
} from "@virentia/core";
import type { Ref } from "vue";
import type { UnitRef, UnitValue } from "../../lib";
import type { AnyStore } from "../../lib/types";

// ---------------------------------------------------------------------------
// UnitRef: how a unit is exposed inside a Vue setup (stores -> refs)
// ---------------------------------------------------------------------------
describe("UnitRef", () => {
  it("exposes primitive stores as Readonly<Ref<value>>", () => {
    expectTypeOf<UnitRef<StoreWritable<boolean>>>().toEqualTypeOf<Readonly<Ref<boolean>>>();
    expectTypeOf<UnitRef<Store<string | null>>>().toEqualTypeOf<Readonly<Ref<string | null>>>();
  });

  // TODO(phase-2 dedup): overlaps "exposes primitive stores as Readonly<Ref<value>>"
  it("exposes primitive stores as readonly refs of the value type", () => {
    expectTypeOf<UnitRef<ReturnType<typeof store<boolean>>>>().toEqualTypeOf<
      Readonly<Ref<boolean>>
    >();
    expectTypeOf<UnitRef<ReturnType<typeof store<string | null>>>>().toEqualTypeOf<
      Readonly<Ref<string | null>>
    >();
  });

  it("exposes object reactives as Readonly<Ref<object>>", () => {
    expectTypeOf<UnitRef<Reactive<{ name: string; age: number }>>>().toEqualTypeOf<
      Readonly<Ref<{ name: string; age: number }>>
    >();
    expectTypeOf<UnitRef<ReactiveWritable<{ a: number }>>>().toEqualTypeOf<
      Readonly<Ref<{ a: number }>>
    >();
  });

  // TODO(phase-2 dedup): overlaps "exposes object reactives as Readonly<Ref<object>>"
  it("unwraps object reactives and event/effect units", () => {
    const user = reactive({ name: "", age: 0 });
    const submit = event<string>();
    const loadFx = effect(async (id: number) => id.toString());
    expectTypeOf<UnitRef<typeof user>>().toEqualTypeOf<
      Readonly<Ref<{ name: string; age: number }>>
    >();
    expectTypeOf<UnitRef<typeof submit>>().toEqualTypeOf<(payload: string) => Promise<void>>();
    expectTypeOf<UnitRef<typeof loadFx>>().parameter(0).toEqualTypeOf<number>();
  });

  it("maps events to scope-bound callables (Vue mirrors the react UnitValue for events)", () => {
    expectTypeOf<UnitRef<EventCallable<string>>>().toEqualTypeOf<
      (payload: string) => Promise<void>
    >();
    expectTypeOf<UnitRef<EventCallable<void>>>().toEqualTypeOf<(payload?: void) => Promise<void>>();
  });

  // TODO(phase-2 dedup): overlaps "maps events to scope-bound callables (Vue mirrors the react UnitValue for events)"
  it("maps an event to a payload callable", () => {
    expectTypeOf<UnitRef<EventCallable<string>>>().toEqualTypeOf<
      (payload: string) => Promise<void>
    >();
  });

  it("maps effects to callables resolving to Done", () => {
    expectTypeOf<UnitRef<Effect<number, string, Error>>>().toEqualTypeOf<
      (params: number, options?: EffectCallOptions) => Promise<string>
    >();
    expectTypeOf<UnitRef<Effect<void, boolean, unknown>>>().toEqualTypeOf<
      (params: void, options?: EffectCallOptions) => Promise<boolean>
    >();
  });

  it("differs from UnitValue for stores: ref vs bare value", () => {
    expectTypeOf<UnitRef<Store<number>>>().not.toEqualTypeOf<UnitValue<Store<number>>>();
    expectTypeOf<UnitRef<Store<number>>>().toEqualTypeOf<Readonly<Ref<number>>>();
    expectTypeOf<UnitValue<Store<number>>>().toEqualTypeOf<number>();
  });

  it("resolves a non-unit to never (fallthrough)", () => {
    expectTypeOf<UnitRef<number>>().toEqualTypeOf<never>();
    expectTypeOf<UnitRef<{ a: number }>>().toEqualTypeOf<never>();
    expectTypeOf<UnitRef<Record<string, never>>>().toEqualTypeOf<never>();
  });

  it("distributes over a union of units", () => {
    expectTypeOf<UnitRef<Store<number> | EventCallable<string>>>().toEqualTypeOf<
      Readonly<Ref<number>> | ((payload: string) => Promise<void>)
    >();
  });

  it("collapses all four store variants of one value type to a single ref", () => {
    expectTypeOf<UnitRef<AnyStore<number>>>().toEqualTypeOf<Readonly<Ref<number>>>();
  });
});
