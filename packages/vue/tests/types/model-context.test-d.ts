import { describe, expectTypeOf, it } from "vitest";
import type {
  EventCallable,
  Owner,
  ReactiveWritable,
  Scope,
  Store,
  StoreWritable,
} from "@virentia/core";
import type { ModelContext, ModelFactory, ModelInstance } from "../../lib";

// ---------------------------------------------------------------------------
// ModelContext / ModelFactory / ModelInstance
// ---------------------------------------------------------------------------
describe("ModelContext / ModelFactory / ModelInstance", () => {
  it("ModelContext exposes the scoped lifecycle surface", () => {
    type Ctx = ModelContext<{ step: number }, string>;
    expectTypeOf<Ctx["scope"]>().toEqualTypeOf<Scope>();
    expectTypeOf<Ctx["owner"]>().toEqualTypeOf<Owner>();
    expectTypeOf<Ctx["props"]>().toEqualTypeOf<ReactiveWritable<{ step: number }>>();
    expectTypeOf<Ctx["mounted"]>().toEqualTypeOf<EventCallable<void>>();
    expectTypeOf<Ctx["unmounted"]>().toEqualTypeOf<EventCallable<void>>();
    expectTypeOf<Ctx["mounts"]>().toEqualTypeOf<StoreWritable<number>>();
    expectTypeOf<Ctx["key"]>().toEqualTypeOf<string>();
  });

  it("ModelContext key defaults to undefined", () => {
    type Ctx = ModelContext<{ step: number }>;
    expectTypeOf<Ctx["key"]>().toEqualTypeOf<undefined>();
  });

  it("ModelFactory is a context -> model function", () => {
    type Factory = ModelFactory<{ step: number }, { c: Store<number> }, string>;
    expectTypeOf<Factory>().parameter(0).toEqualTypeOf<ModelContext<{ step: number }, string>>();
    expectTypeOf<Factory>().returns.toEqualTypeOf<{ c: Store<number> }>();
  });

  it("ModelFactory key defaults to undefined in the context", () => {
    type Factory = ModelFactory<{ step: number }, { c: Store<number> }>;
    expectTypeOf<Factory>().parameter(0).toEqualTypeOf<ModelContext<{ step: number }, undefined>>();
  });

  it("ModelInstance extends the context and adds model + dispose", () => {
    type Instance = ModelInstance<{ step: number }, { c: Store<number> }, string>;
    expectTypeOf<Instance["model"]>().toEqualTypeOf<{ c: Store<number> }>();
    expectTypeOf<Instance["dispose"]>().toEqualTypeOf<() => void>();
    expectTypeOf<Instance["scope"]>().toEqualTypeOf<Scope>();
    expectTypeOf<Instance["props"]>().toEqualTypeOf<ReactiveWritable<{ step: number }>>();
    expectTypeOf<Instance["key"]>().toEqualTypeOf<string>();
  });
});
