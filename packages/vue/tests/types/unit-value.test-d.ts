import { describe, expectTypeOf, it } from "vitest";
import { store } from "@virentia/core";
import type {
  Effect,
  EffectCallOptions,
  EventCallable,
  Reactive,
  ReactiveWritable,
  Store,
  StoreWritable,
} from "@virentia/core";
import type { UnitValue } from "../../lib";
import type { AnyStore } from "../../lib/types";

// ---------------------------------------------------------------------------
// UnitValue: raw value carried by a unit
// ---------------------------------------------------------------------------
describe("UnitValue", () => {
  it("resolves a writable primitive store to its value type (no Ref, no store shape)", () => {
    expectTypeOf<UnitValue<StoreWritable<boolean>>>().toEqualTypeOf<boolean>();
    expectTypeOf<UnitValue<StoreWritable<string>>>().toEqualTypeOf<string>();
    expectTypeOf<UnitValue<StoreWritable<number>>>().toEqualTypeOf<number>();
  });

  // TODO(phase-2 dedup): overlaps "resolves a writable primitive store to its value type (no Ref, no store shape)"
  it("unwraps primitive stores to their value type", () => {
    // Regression: primitive stores must not leak `{ value: T } & StoreApi<T>`
    // into the resolved type (caused by a distributive `T extends object`).
    expectTypeOf<UnitValue<ReturnType<typeof store<boolean>>>>().toEqualTypeOf<boolean>();
    expectTypeOf<UnitValue<ReturnType<typeof store<string>>>>().toEqualTypeOf<string>();
    expectTypeOf<UnitValue<ReturnType<typeof store<string | null>>>>().toEqualTypeOf<
      string | null
    >();
  });

  it("resolves a read-only store to its value type", () => {
    expectTypeOf<UnitValue<Store<boolean>>>().toEqualTypeOf<boolean>();
    expectTypeOf<UnitValue<Store<string | null>>>().toEqualTypeOf<string | null>();
  });

  it("resolves object reactives to the object value (not the reactive wrapper)", () => {
    expectTypeOf<UnitValue<Reactive<{ a: number; b: string }>>>().toEqualTypeOf<{
      a: number;
      b: string;
    }>();
    expectTypeOf<UnitValue<ReactiveWritable<{ a: number }>>>().toEqualTypeOf<{ a: number }>();
  });

  it("maps events to a scope-bound callable returning Promise<void>", () => {
    expectTypeOf<UnitValue<EventCallable<string>>>().toEqualTypeOf<
      (payload: string) => Promise<void>
    >();
  });

  it("maps a void event to an optional-payload callable", () => {
    expectTypeOf<UnitValue<EventCallable<void>>>().toEqualTypeOf<
      (payload?: void) => Promise<void>
    >();
  });

  it("maps a union-payload event to a required-payload callable", () => {
    expectTypeOf<UnitValue<EventCallable<string | number>>>().toEqualTypeOf<
      (payload: string | number) => Promise<void>
    >();
  });

  it("maps an optional/undefined-payload event to an optional-payload callable", () => {
    expectTypeOf<UnitValue<EventCallable<string | undefined>>>().toEqualTypeOf<
      (payload?: string | undefined) => Promise<void>
    >();
  });

  it("maps effects to a callable resolving to the Done value", () => {
    expectTypeOf<UnitValue<Effect<number, string, Error>>>().toEqualTypeOf<
      (params: number, options?: EffectCallOptions) => Promise<string>
    >();
  });

  it("resolves a non-unit to never (fallthrough, not an internal leak)", () => {
    expectTypeOf<UnitValue<number>>().toEqualTypeOf<never>();
    expectTypeOf<UnitValue<string>>().toEqualTypeOf<never>();
    expectTypeOf<UnitValue<{ a: number }>>().toEqualTypeOf<never>();
    expectTypeOf<UnitValue<Record<string, never>>>().toEqualTypeOf<never>();
  });

  it("distributes over a union of units", () => {
    expectTypeOf<UnitValue<Store<number> | EventCallable<string>>>().toEqualTypeOf<
      number | ((payload: string) => Promise<void>)
    >();
  });

  it("collapses a union of all four store variants of one value type to that value", () => {
    expectTypeOf<UnitValue<AnyStore<number>>>().toEqualTypeOf<number>();
  });
});
