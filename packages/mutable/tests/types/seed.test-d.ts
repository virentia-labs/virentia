import { describe, expectTypeOf, it } from "vitest";
import { scope } from "@virentia/core";
import type { Scope } from "@virentia/core";
import { mutableStore, seedMutableStore } from "../../lib";
import type { MutableStore } from "../../lib";

describe("mutable types — seedMutableStore", () => {
  it("has signature (scope: Scope, store: MutableStore<T>, value: T) => void", () => {
    expectTypeOf(seedMutableStore<{ a: number }>).toEqualTypeOf<
      (scope: Scope, store: MutableStore<{ a: number }>, value: { a: number }) => void
    >();
    expectTypeOf(seedMutableStore<{ a: number }>).parameter(0).toEqualTypeOf<Scope>();
    expectTypeOf(seedMutableStore<{ a: number }>)
      .parameter(1)
      .toEqualTypeOf<MutableStore<{ a: number }>>();
    expectTypeOf(seedMutableStore<{ a: number }>).parameter(2).toEqualTypeOf<{ a: number }>();
    expectTypeOf(seedMutableStore<{ a: number }>).returns.toEqualTypeOf<void>();
  });

  it("is callable with a matching scope/store/value triple", () => {
    const s = mutableStore({ count: 0 });
    expectTypeOf(seedMutableStore).toBeCallableWith(scope(), s, { count: 42 });
  });

  it("rejects a seed value whose shape does not match the store's T", () => {
    function _bad(): void {
      const s = mutableStore({ count: 0 });
      // @ts-expect-error seed value must be assignable to the store's T
      seedMutableStore(scope(), s, { wrong: 1 });
    }
    void _bad;
  });
});
