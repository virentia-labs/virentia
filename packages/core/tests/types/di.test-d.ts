import { describe, expectTypeOf, it } from "vitest";
import { dependency, lazyModel, provideDependency, store } from "../../lib";
import type {
  Dependency,
  EventCallable,
  LazyModel,
  LazyModelLoader,
  Store,
  StoreWritable,
} from "../../lib";
import { makeCounter, type CounterModel } from "../support/lazy-counter";

describe("dependency types", () => {
  it("infers Dependency shape and value", () => {
    expectTypeOf(dependency<string>()).toEqualTypeOf<Dependency<string>>();
    expectTypeOf<Dependency<string>["value"]>().toEqualTypeOf<string>();
    expectTypeOf<Dependency<{ client: number }>["value"]>().toEqualTypeOf<{ client: number }>();
    // value is readonly.
    if (false as boolean) {
      const dep = dependency<string>();
      // @ts-expect-error Dependency.value is readonly.
      dep.value = "x";
    }
    expectTypeOf(provideDependency<string>).parameter(1).toEqualTypeOf<Dependency<string>>();
    expectTypeOf(provideDependency<string>).parameter(2).toEqualTypeOf<string>();
  });
});

describe("lazyModel types", () => {
  it("infers LazyModel shape with a pending store", () => {
    const lm = lazyModel(() => ({ count: store(0), name: store("x") }));
    expectTypeOf(lm).toEqualTypeOf<
      LazyModel<{ count: StoreWritable<number>; name: StoreWritable<string> }>
    >();
    expectTypeOf(lm.pending).toEqualTypeOf<Store<boolean>>();
    expectTypeOf(lm.count).toEqualTypeOf<StoreWritable<number>>();
    expectTypeOf(lm.name).toEqualTypeOf<StoreWritable<string>>();

    expectTypeOf<LazyModelLoader<{ a: number }>>().toEqualTypeOf<
      () => { a: number } | PromiseLike<{ a: number }>
    >();
  });

  it("preserves member unit types and adds a pending store", () => {
    const model = lazyModel<CounterModel>(async () => makeCounter());

    expectTypeOf(model.count).toEqualTypeOf<StoreWritable<number>>();
    expectTypeOf(model.incremented).toEqualTypeOf<EventCallable<number>>();
    expectTypeOf(model.pending).toEqualTypeOf<Store<boolean>>();
  });
});
