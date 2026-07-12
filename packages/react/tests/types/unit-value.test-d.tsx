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
import type { UnitLike, UnitValue } from "../../lib";

// ---------------------------------------------------------------------------
// UnitValue<Unit>
// ---------------------------------------------------------------------------

describe("UnitValue store unwrapping", () => {
  it("unwraps every AnyStore flavour to its state (primitive)", () => {
    expectTypeOf<UnitValue<Store<number>>>().toEqualTypeOf<number>();
    expectTypeOf<UnitValue<StoreWritable<number>>>().toEqualTypeOf<number>();
  });

  it("unwraps reactive object stores to the raw object state (no StoreApi leak)", () => {
    expectTypeOf<UnitValue<Reactive<{ name: string; age: number }>>>().toEqualTypeOf<{
      name: string;
      age: number;
    }>();
    expectTypeOf<UnitValue<ReactiveWritable<{ id: string }>>>().toEqualTypeOf<{ id: string }>();
  });

  it("does not leak the store API when the state itself is an object", () => {
    // Regression guard: a distributive `T extends object` used to fold the whole
    // `{ value: T } & StoreApi<T>` shape into the resolved type.
    expectTypeOf<UnitValue<Store<{ deep: number }>>>().toEqualTypeOf<{ deep: number }>();
    expectTypeOf<UnitValue<StoreWritable<{ deep: number }>>>().toEqualTypeOf<{ deep: number }>();
    expectTypeOf<UnitValue<Store<number[]>>>().toEqualTypeOf<number[]>();
  });

  it("preserves union and nullable state without collapsing", () => {
    expectTypeOf<UnitValue<Store<string | null>>>().toEqualTypeOf<string | null>();
    expectTypeOf<UnitValue<Store<number | string>>>().toEqualTypeOf<number | string>();
    expectTypeOf<UnitValue<Store<undefined>>>().toEqualTypeOf<undefined>();
    expectTypeOf<UnitValue<StoreWritable<boolean>>>().toEqualTypeOf<boolean>();
  });
});

describe("UnitValue event unwrapping", () => {
  it("unwraps a payload event to a scoped async caller", () => {
    expectTypeOf<UnitValue<EventCallable<string>>>().toEqualTypeOf<
      (payload: string) => Promise<void>
    >();
  });

  it("unwraps a void event to a no-argument caller (EventPayload<void> is [payload?: void])", () => {
    expectTypeOf<UnitValue<EventCallable<void>>>().toEqualTypeOf<
      (payload?: void) => Promise<void>
    >();
    expectTypeOf<UnitValue<EventCallable<void>>>().toBeCallableWith(undefined);
    expectTypeOf<UnitValue<EventCallable<void>>>().returns.toEqualTypeOf<Promise<void>>();
  });

  it("keeps the payload optional when the payload type admits undefined", () => {
    expectTypeOf<UnitValue<EventCallable<string | undefined>>>().toEqualTypeOf<
      (payload?: string | undefined) => Promise<void>
    >();
  });

  it("keeps a union payload as a single required argument", () => {
    expectTypeOf<UnitValue<EventCallable<number | string>>>().toEqualTypeOf<
      (payload: number | string) => Promise<void>
    >();
    expectTypeOf<UnitValue<EventCallable<{ a: number }>>>().parameter(0).toEqualTypeOf<{
      a: number;
    }>();
  });
});

describe("UnitValue effect unwrapping", () => {
  it("unwraps an effect to (params, options?) => Promise<Done> (EffectCallArgs)", () => {
    type Fx = UnitValue<Effect<number, string, unknown>>;
    expectTypeOf<Fx>().parameter(0).toEqualTypeOf<number>();
    expectTypeOf<Fx>().parameter(1).toEqualTypeOf<EffectCallOptions | undefined>();
    expectTypeOf<Fx>().returns.toEqualTypeOf<Promise<string>>();
  });

  it("accepts the effect caller with or without the optional options argument", () => {
    type Fx = UnitValue<Effect<number, string, unknown>>;
    expectTypeOf<Fx>().toBeCallableWith(1);
    expectTypeOf<Fx>().toBeCallableWith(1, {});
    expectTypeOf<Fx>().toBeCallableWith(1, { signal: new AbortController().signal });
  });

  it("unwraps a void-params / void-done effect", () => {
    type Fx = UnitValue<Effect<void, void, unknown>>;
    expectTypeOf<Fx>().toEqualTypeOf<(params: void, options?: EffectCallOptions) => Promise<void>>();
    expectTypeOf<Fx>().returns.toEqualTypeOf<Promise<void>>();
    expectTypeOf<Fx>().toBeCallableWith(undefined);
  });
});

describe("UnitValue edge cases (never-leak / distributivity probes)", () => {
  it("resolves to never for anything that is not a unit", () => {
    expectTypeOf<UnitValue<{}>>().toBeNever();
    expectTypeOf<UnitValue<{ node: string }>>().toBeNever();
    expectTypeOf<UnitValue<string>>().toBeNever();
    expectTypeOf<UnitValue<number>>().toBeNever();
    expectTypeOf<UnitValue<() => void>>().toBeNever();
    expectTypeOf<UnitValue<{ name: string; age: number }>>().toBeNever();
  });

  it("distributes over unions of units", () => {
    expectTypeOf<UnitValue<Store<number> | EventCallable<string>>>().toEqualTypeOf<
      number | ((payload: string) => Promise<void>)
    >();
    expectTypeOf<UnitValue<Store<number> | Store<string>>>().toEqualTypeOf<number | string>();
  });

  it("resolves never for the never input (empty distribution)", () => {
    expectTypeOf<UnitValue<never>>().toBeNever();
  });
});

describe("UnitValue (smoke)", () => {
  it("maps a void event and an effect's options parameter to their callable shapes", () => {
    const done = event<void>();
    const fx = effect(async (id: number) => id);
    expectTypeOf<UnitValue<typeof done>>().returns.toEqualTypeOf<Promise<void>>();
    expectTypeOf<UnitValue<typeof fx>>().parameter(1).toEqualTypeOf<EffectCallOptions | undefined>();
    expectTypeOf<UnitValue<typeof fx>>().returns.toEqualTypeOf<Promise<number>>();
  });
});

// ---------------------------------------------------------------------------
// UnitLike
// ---------------------------------------------------------------------------

describe("UnitLike", () => {
  it("collapses to any (documented: ReactiveWritable<any> = any & ... = any)", () => {
    // This is why ReactiveModel discriminates units by their `.node` marker
    // rather than by `Model[Key] extends UnitLike`.
    expectTypeOf<UnitLike>().toBeAny();
  });
});

// ---------------------------------------------------------------------------
// Overlapping subset originally in types.test.ts
// ---------------------------------------------------------------------------

describe("UnitValue (runtime-value probes)", () => {
  // TODO(phase-2 dedup): overlaps "unwraps every AnyStore flavour to its state (primitive)"
  it("unwraps primitive stores to their value type", () => {
    // Regression: primitive stores must not leak `{ value: T } & StoreApi<T>`
    // into the resolved type (caused by a distributive `T extends object`).
    expectTypeOf<UnitValue<ReturnType<typeof store<boolean>>>>().toEqualTypeOf<boolean>();
    expectTypeOf<UnitValue<ReturnType<typeof store<string>>>>().toEqualTypeOf<string>();
    expectTypeOf<UnitValue<ReturnType<typeof store<number>>>>().toEqualTypeOf<number>();
    expectTypeOf<UnitValue<ReturnType<typeof store<string | null>>>>().toEqualTypeOf<
      string | null
    >();
  });

  // TODO(phase-2 dedup): overlaps "unwraps reactive object stores to the raw object state (no StoreApi leak)"
  it("unwraps object reactives to their state", () => {
    const user = reactive({ name: "", age: 0 });
    expectTypeOf<UnitValue<typeof user>>().toEqualTypeOf<{ name: string; age: number }>();
  });

  // TODO(phase-2 dedup): overlaps "unwraps a payload event to a scoped async caller"
  it("unwraps events and effects to bound callables", () => {
    const submit = event<string>();
    const loadFx = effect(async (id: number) => id.toString());
    expectTypeOf<UnitValue<typeof submit>>().toEqualTypeOf<(payload: string) => Promise<void>>();
    expectTypeOf<UnitValue<typeof loadFx>>().parameter(0).toEqualTypeOf<number>();
    expectTypeOf<UnitValue<typeof loadFx>>().returns.toEqualTypeOf<Promise<string>>();
  });
});
