import { describe, expectTypeOf, it } from "vitest";
import type { Node, Scope, Store } from "@virentia/core";
import { mutableStore } from "../../lib";
import type { MutableStore } from "../../lib";

// Canonical store shape reused across the suite.
type UserState = { user: { tags: string[] }; n: number };

describe("mutable types — node & writable", () => {
  it("types node as Node and writable as the literal `true`", () => {
    const s = mutableStore({ a: 1 });
    expectTypeOf(s.node).toEqualTypeOf<Node>();
    expectTypeOf(s.writable).toEqualTypeOf<true>();
    // Not merely `boolean`: it is the narrowed literal.
    expectTypeOf(s.writable).not.toEqualTypeOf<boolean>();
    expectTypeOf(s.writable).not.toEqualTypeOf<false>();
  });
});

describe("mutable types — subscribe", () => {
  it("takes (value: T, scope: Scope) => void and returns an unsubscribe () => void", () => {
    const s = mutableStore({ user: { tags: ["x"] }, n: 0 });
    expectTypeOf(s.subscribe).toEqualTypeOf<
      (fn: (value: UserState, scope: Scope) => void) => () => void
    >();
    expectTypeOf(s.subscribe).returns.toEqualTypeOf<() => void>();
    expectTypeOf(s.subscribe).parameter(0).toEqualTypeOf<(value: UserState, scope: Scope) => void>();
    // The callback's own parameters.
    expectTypeOf(s.subscribe).parameter(0).parameter(0).toEqualTypeOf<UserState>();
    expectTypeOf(s.subscribe).parameter(0).parameter(1).toEqualTypeOf<Scope>();
  });

  it("returns a callable unsubscribe when invoked", () => {
    const s = mutableStore({ n: 0 });
    const off = s.subscribe(() => {});
    expectTypeOf(off).toEqualTypeOf<() => void>();
  });

  it("rejects a subscriber whose value parameter is the wrong type", () => {
    function _bad(): void {
      const s = mutableStore({ n: 0 });
      // @ts-expect-error value param is `{ n: number }`, not string
      s.subscribe((v: string) => void v);
    }
    void _bad;
  });
});

describe("mutable types — map", () => {
  it("infers U from the mapper and returns a full Store<U>", () => {
    const s = mutableStore({ n: 0 });
    const dNum = s.map((v) => v.n * 2);
    expectTypeOf(dNum).toEqualTypeOf<Store<number>>();
    expectTypeOf<(typeof dNum)["value"]>().toEqualTypeOf<number>();

    const dStr = s.map((v) => `${v.n}`);
    expectTypeOf(dStr).toEqualTypeOf<Store<string>>();

    const dObj = s.map((v) => ({ doubled: v.n * 2 }));
    expectTypeOf(dObj).toEqualTypeOf<Store<{ doubled: number }>>();
  });

  it("passes the deeply-mutable T into the mapper", () => {
    const s = mutableStore({ user: { tags: ["x"] }, n: 0 });
    expectTypeOf(s.map).parameter(0).toEqualTypeOf<(value: UserState) => unknown>();
    expectTypeOf(s.map).parameter(0).parameter(0).toEqualTypeOf<UserState>();
  });

  it("returns a Store<U> that is itself chainable (map/filter/filterMap)", () => {
    const s = mutableStore({ n: 0 });
    const chained = s.map((v) => v.n).filter((x) => x > 0);
    expectTypeOf(chained).toEqualTypeOf<Store<number>>();
    const remapped = s.map((v) => v.n).map((x) => `${x}`);
    expectTypeOf(remapped).toEqualTypeOf<Store<string>>();
  });

  it("MutableStore.map accepts only the mapper (no skipToken overload of the core StoreApi)", () => {
    function _bad(): void {
      const s = mutableStore({ n: 0 });
      // @ts-expect-error MutableStore.map is unary; there is no skipToken parameter
      s.map((v) => v.n, 99);
    }
    void _bad;
  });
});

describe("mutable types — MutableStore<T> structural relationships", () => {
  it("is NOT assignable to Store<T> (it lacks filter/filterMap and exposes writable:true)", () => {
    expectTypeOf<MutableStore<{ a: number }>>().not.toMatchTypeOf<Store<{ a: number }>>();
  });

  it("exposes exactly node, writable, value, subscribe and map", () => {
    expectTypeOf<MutableStore<{ a: number }>>().toHaveProperty("node");
    expectTypeOf<MutableStore<{ a: number }>>().toHaveProperty("writable");
    expectTypeOf<MutableStore<{ a: number }>>().toHaveProperty("value");
    expectTypeOf<MutableStore<{ a: number }>>().toHaveProperty("subscribe");
    expectTypeOf<MutableStore<{ a: number }>>().toHaveProperty("map");
    expectTypeOf<MutableStore<{ a: number }>>().not.toHaveProperty("filter");
    expectTypeOf<MutableStore<{ a: number }>>().not.toHaveProperty("filterMap");
  });

  it("value is a deeply-mutable T, map returns Store<U>, node/writable are literal types", () => {
    const s = mutableStore({ user: { tags: ["x"] }, n: 0 });
    // Use the type-level form: `s.value` is a getter that throws without a scope.
    expectTypeOf<(typeof s)["value"]>().toEqualTypeOf<{ user: { tags: string[] }; n: number }>();
    const d = s.map((v) => v.n * 2);
    expectTypeOf(d).toMatchTypeOf<Store<number>>();
    expectTypeOf(s.node).toEqualTypeOf<Node>();
    expectTypeOf(s.writable).toEqualTypeOf<true>();
    // @ts-expect-error primitive initial is rejected (T extends object)
    mutableStore(5);
  });
});
