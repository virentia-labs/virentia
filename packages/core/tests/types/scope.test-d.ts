import { describe, expectTypeOf, it } from "vitest";
import { getCurrentScope, scope, scoped } from "../../lib";
import type { Scope, ScopeOptions, ScopedRunner } from "../../lib";

describe("scope types", () => {
  it("infers scope / getCurrentScope / ScopeOptions", () => {
    expectTypeOf(scope()).toEqualTypeOf<Scope>();
    expectTypeOf(scope({})).toEqualTypeOf<Scope>();
    expectTypeOf(getCurrentScope()).toEqualTypeOf<Scope | null>();
    expectTypeOf<Scope>().toEqualTypeOf<{
      readonly values: Map<symbol, unknown>;
      readonly handlers: Map<object, (...args: any[]) => unknown>;
      readonly deps: Map<symbol, unknown>;
    }>();
    expectTypeOf<ScopeOptions["values"]>().toBeNullable();
  });

  it("infers scoped overloads and ScopedRunner", () => {
    // scoped(scope, fn) returns the callback result type.
    expectTypeOf(scoped).toBeCallableWith(scope(), () => 1);
    // ScopedRunner is callable and exposes run/wrap.
    expectTypeOf<ScopedRunner>().toBeCallableWith(() => 1);
    expectTypeOf<ScopedRunner["run"]>().toBeCallableWith(() => "x");
    expectTypeOf<ScopedRunner["wrap"]>().toBeCallableWith((a: number) => a + 1);
    // scoped(scope, fn) returns the callback result type.
    expectTypeOf(scoped(scope(), () => 7)).toEqualTypeOf<number>();
  });

  it("resolves scoped() overload return types", () => {
    const s = scope();

    expectTypeOf(scoped(s)).toEqualTypeOf<ScopedRunner>();
    expectTypeOf(scoped(s, () => 1)).toEqualTypeOf<number>();

    scoped(s, () => {
      expectTypeOf(scoped(() => "a")).toEqualTypeOf<string>();
      expectTypeOf(scoped()).toEqualTypeOf<ScopedRunner>();
    });
  });

  it("preserves wrap's parameter tuple and return type", () => {
    const f = scoped(scope()).wrap((a: number, b: string) => a > 0 && b.length > 0);

    expectTypeOf(f).parameters.toEqualTypeOf<[number, string]>();
    expectTypeOf(f).returns.toEqualTypeOf<boolean>();
  });
});
