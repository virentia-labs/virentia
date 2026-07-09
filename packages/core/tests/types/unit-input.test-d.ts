import { describe, expectTypeOf, it } from "vitest";
import type {
  AnyUnit,
  Effect,
  Event,
  EventCallable,
  Node,
  Reactive,
  ReactiveWritable,
  SourceInput,
  Store,
  StoreWritable,
  Unit,
  UnitInput,
  UnitList,
} from "../../lib";
// SourceUnit / WatchableUnit are not re-exported from the public index; they are
// exercised via the deep module path so their inference paths are covered too.
import type { SourceUnit, WatchableUnit } from "../../lib/graph/reaction";

describe("unit input helper types", () => {
  it("computes UnitInput for every source unit kind", () => {
    expectTypeOf<UnitInput<StoreWritable<number>>>().toEqualTypeOf<number>();
    expectTypeOf<UnitInput<Store<number>>>().toEqualTypeOf<number>();
    expectTypeOf<UnitInput<ReactiveWritable<{ a: number }>>>().toEqualTypeOf<{ a: number }>();
    expectTypeOf<UnitInput<Reactive<{ a: number }>>>().toEqualTypeOf<{ a: number }>();
    expectTypeOf<UnitInput<EventCallable<string>>>().toEqualTypeOf<string>();
    expectTypeOf<UnitInput<Event<string>>>().toEqualTypeOf<string>();
    expectTypeOf<UnitInput<Effect<string, number, Error>>>().toEqualTypeOf<string>();
    // a value that is not a unit resolves to never.
    expectTypeOf<UnitInput<number>>().toBeNever();
    expectTypeOf<UnitInput<never>>().toBeNever();
  });

  it("computes SourceInput for single unit / tuple / empty tuple", () => {
    expectTypeOf<SourceInput<StoreWritable<number>>>().toEqualTypeOf<number>();
    expectTypeOf<
      SourceInput<readonly [EventCallable<string>, StoreWritable<number>]>
    >().toEqualTypeOf<string | number>();
    // an empty source list resolves to never.
    expectTypeOf<SourceInput<readonly []>>().toBeNever();
  });

  it("computes UnitList / SourceUnit / AnyUnit / Unit", () => {
    expectTypeOf<StoreWritable<number>>().toMatchTypeOf<UnitList<number>>();
    expectTypeOf<readonly [StoreWritable<number>]>().toMatchTypeOf<UnitList<number>>();
    expectTypeOf<StoreWritable<number>>().toMatchTypeOf<SourceUnit<number>>();
    expectTypeOf<StoreWritable<number>>().toMatchTypeOf<AnyUnit>();
    expectTypeOf<Unit<number>>().toEqualTypeOf<{ readonly node: Node }>();
  });

  it("BUG: UnitInput cannot recover the payload of a WatchableUnit", () => {
    // `Unit<_T>`'s type parameter is phantom (unused in the interface body), so
    // UnitInput's final `Unit<infer Payload>` branch cannot recover the payload
    // of a WatchableUnit and yields `unknown` instead of the real `string`.
    expectTypeOf<UnitInput<WatchableUnit<string>>>().toEqualTypeOf<unknown>();
    // @ts-expect-error KNOWN BUG: should be `string`, resolves to `unknown`.
    expectTypeOf<UnitInput<WatchableUnit<string>>>().toEqualTypeOf<string>();
  });
});
