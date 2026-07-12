import { describe, expectTypeOf, it } from "vitest";
import type { Scope, Store } from "@virentia/core";
import { createModelCache } from "../../lib";
import type { ModelCache, ModelInstance } from "../../lib";
import type { CacheOptions } from "../../lib/types";

// ---------------------------------------------------------------------------
// ModelCache / CacheOptions / createModelCache
// ---------------------------------------------------------------------------
describe("ModelCache / CacheOptions", () => {
  type Key = string;
  type Props = { step: number };
  type Model = { c: Store<number> };
  type Cache = ModelCache<Key, Props, Model>;

  it("has() takes (key, scope?) and returns boolean", () => {
    expectTypeOf<Cache["has"]>().toEqualTypeOf<(key: Key, scope?: Scope) => boolean>();
  });

  it("get() returns the model or undefined", () => {
    expectTypeOf<Cache["get"]>().toEqualTypeOf<(key: Key, scope?: Scope) => Model | undefined>();
  });

  it("getInstance() returns a ModelInstance or undefined", () => {
    expectTypeOf<Cache["getInstance"]>().toEqualTypeOf<
      (key: Key, scope?: Scope) => ModelInstance<Props, Model, Key> | undefined
    >();
  });

  it("delete() returns boolean and clear() returns void", () => {
    expectTypeOf<Cache["delete"]>().toEqualTypeOf<(key: Key, scope?: Scope) => boolean>();
    expectTypeOf<Cache["clear"]>().toEqualTypeOf<(scope?: Scope) => void>();
  });

  it("scope argument is optional on every method", () => {
    expectTypeOf<Cache["has"]>().toBeCallableWith("k");
    expectTypeOf<Cache["get"]>().toBeCallableWith("k");
    expectTypeOf<Cache["delete"]>().toBeCallableWith("k");
    expectTypeOf<Cache["clear"]>().toBeCallableWith();
  });

  it("CacheOptions bundles a matching cache and key", () => {
    type Opts = CacheOptions<Props, Key, Model>;
    expectTypeOf<Opts["cache"]>().toEqualTypeOf<ModelCache<Key, Props, Model>>();
    expectTypeOf<Opts["key"]>().toEqualTypeOf<Key>();
  });

  it("createModelCache returns a ModelCache of the requested generics", () => {
    expectTypeOf<ReturnType<typeof createModelCache<Key, Props, Model>>>().toEqualTypeOf<
      ModelCache<Key, Props, Model>
    >();
  });
});
