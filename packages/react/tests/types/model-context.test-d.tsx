import { describe, expectTypeOf, it } from "vitest";
import type {
  EventCallable,
  Owner,
  ReactiveWritable,
  Scope,
  StoreWritable,
} from "@virentia/core";
import type { ModelCache, ModelContext, ModelFactory, ModelInstance } from "../../lib";

// ---------------------------------------------------------------------------
// ModelContext / ModelFactory / ModelInstance / ModelCache
// ---------------------------------------------------------------------------

describe("ModelContext", () => {
  type Ctx = ModelContext<{ a: number }, string>;

  it("exposes the framework-managed units at their exact types", () => {
    expectTypeOf<Ctx["scope"]>().toEqualTypeOf<Scope>();
    expectTypeOf<Ctx["owner"]>().toEqualTypeOf<Owner>();
    expectTypeOf<Ctx["props"]>().toEqualTypeOf<ReactiveWritable<{ a: number }>>();
    expectTypeOf<Ctx["mounted"]>().toEqualTypeOf<EventCallable<void>>();
    expectTypeOf<Ctx["unmounted"]>().toEqualTypeOf<EventCallable<void>>();
    expectTypeOf<Ctx["mounts"]>().toEqualTypeOf<StoreWritable<number>>();
    expectTypeOf<Ctx["key"]>().toEqualTypeOf<string>();
  });

  it("defaults the key to undefined", () => {
    expectTypeOf<ModelContext<{ a: number }>["key"]>().toEqualTypeOf<undefined>();
  });
});

describe("ModelFactory", () => {
  it("is (context: ModelContext<Props, Key>) => Model", () => {
    type F = ModelFactory<{ a: number }, { count: StoreWritable<number> }, string>;
    expectTypeOf<F>().parameter(0).toEqualTypeOf<ModelContext<{ a: number }, string>>();
    expectTypeOf<F>().returns.toEqualTypeOf<{ count: StoreWritable<number> }>();
  });

  it("defaults the key to undefined in the context param", () => {
    type F = ModelFactory<{ a: number }, { count: StoreWritable<number> }>;
    expectTypeOf<F>().parameter(0).toEqualTypeOf<ModelContext<{ a: number }, undefined>>();
  });
});

describe("ModelInstance", () => {
  type Inst = ModelInstance<{ a: number }, { count: StoreWritable<number> }, string>;

  it("extends ModelContext with model and dispose members", () => {
    expectTypeOf<Inst["model"]>().toEqualTypeOf<{ count: StoreWritable<number> }>();
    expectTypeOf<Inst["props"]>().toEqualTypeOf<ReactiveWritable<{ a: number }>>();
    expectTypeOf<Inst["key"]>().toEqualTypeOf<string>();
    expectTypeOf<Inst["dispose"]>().toEqualTypeOf<() => void>();
  });
});

describe("ModelCache", () => {
  type Cache = ModelCache<string, { a: number }, { count: StoreWritable<number> }>;

  it("has key-parameterised accessors with the model as the value type", () => {
    expectTypeOf<Cache["has"]>().parameter(0).toEqualTypeOf<string>();
    expectTypeOf<Cache["has"]>().returns.toEqualTypeOf<boolean>();
    expectTypeOf<Cache["get"]>().parameter(0).toEqualTypeOf<string>();
    expectTypeOf<Cache["get"]>().returns.toEqualTypeOf<{ count: StoreWritable<number> } | undefined>();
    expectTypeOf<Cache["getInstance"]>().returns.toEqualTypeOf<
      ModelInstance<{ a: number }, { count: StoreWritable<number> }, string> | undefined
    >();
    expectTypeOf<Cache["delete"]>().returns.toEqualTypeOf<boolean>();
    expectTypeOf<Cache["clear"]>().returns.toEqualTypeOf<void>();
  });
});
