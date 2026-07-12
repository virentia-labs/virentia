import { describe, expectTypeOf, it } from "vitest";
import { unwrap } from "../../lib";

describe("mutable types — unwrap", () => {
  it("is an identity on primitives, null and undefined (literals widen to base types)", () => {
    expectTypeOf(unwrap(5)).toEqualTypeOf<number>();
    expectTypeOf(unwrap("x")).toEqualTypeOf<string>();
    expectTypeOf(unwrap(true)).toEqualTypeOf<boolean>();
    expectTypeOf(unwrap(null)).toEqualTypeOf<null>();
    expectTypeOf(unwrap(undefined)).toEqualTypeOf<undefined>();
  });

  it("returns the exact input type for objects, arrays and readonly arrays", () => {
    const o = { k: 1 };
    expectTypeOf(unwrap(o)).toEqualTypeOf<{ k: number }>();

    const arr: number[] = [1, 2, 3];
    expectTypeOf(unwrap(arr)).toEqualTypeOf<number[]>();

    const ro: readonly number[] = [1, 2, 3];
    expectTypeOf(unwrap(ro)).toEqualTypeOf<readonly number[]>();
  });

  it("preserves union and nullable input types without collapse to `any` or `never`", () => {
    const u = { k: 1 } as { k: number } | { k: string } | null;
    expectTypeOf(unwrap(u)).toEqualTypeOf<{ k: number } | { k: string } | null>();

    const maybe = undefined as { a: number } | undefined;
    expectTypeOf(unwrap(maybe)).toEqualTypeOf<{ a: number } | undefined>();
  });

  it("is a plain identity generic (instantiated signature maps T -> T)", () => {
    expectTypeOf(unwrap<{ k: number }>).toEqualTypeOf<(value: { k: number }) => { k: number }>();
    expectTypeOf(unwrap<string>).returns.toEqualTypeOf<string>();
  });
});
