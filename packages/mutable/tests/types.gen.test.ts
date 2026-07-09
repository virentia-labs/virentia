import { describe, expectTypeOf, it } from "vitest";
import { scope } from "@virentia/core";
import type { Node, Scope, Store, StoreDevtoolsOptions } from "@virentia/core";
import { mutableStore, seedMutableStore, unwrap } from "../lib";
import type { MutableStore } from "../lib";

// ---------------------------------------------------------------------------
// EXHAUSTIVE type-level test suite for @virentia/mutable.
//
// Every assertion below is a compile-time check evaluated by `tsc` (vitest runs
// the file as a no-op at runtime). Because `state.value` is a getter that throws
// without an active scope (see mutable-store.ts `scopeOf("read")`), assertions
// about `.value` use the pure type-argument form `expectTypeOf<T>()` /
// `(typeof x)["value"]` so nothing evaluates `.value` at runtime. Method
// references (`s.map`, `s.subscribe`) and constructor calls are runtime-safe.
// ---------------------------------------------------------------------------

// Canonical store shape reused across the suite.
type UserState = { user: { tags: string[] }; n: number };

describe("mutable types — mutableStore constructor & <T extends object> constraint", () => {
  it("returns MutableStore<T> with T inferred from the initial (mutable, non-widened fields)", () => {
    expectTypeOf(mutableStore({ a: 1 })).toEqualTypeOf<MutableStore<{ a: number }>>();
    expectTypeOf(mutableStore({ user: { tags: ["x"] }, n: 0 })).toEqualTypeOf<
      MutableStore<UserState>
    >();
  });

  it("infers array, tuple, record, optional, union, and empty object shapes for T", () => {
    const arr = mutableStore([1, 2, 3]);
    expectTypeOf<(typeof arr)["value"]>().toEqualTypeOf<number[]>();

    const tup = mutableStore([1, 2, 3] as const);
    expectTypeOf<(typeof tup)["value"]>().toEqualTypeOf<readonly [1, 2, 3]>();

    const rec = mutableStore({} as Record<string, number>);
    expectTypeOf<(typeof rec)["value"]>().toEqualTypeOf<Record<string, number>>();
    expectTypeOf<(typeof rec)["value"]["anything"]>().toEqualTypeOf<number>();

    const opt = mutableStore({ a: 1 } as { a: number; b?: number });
    expectTypeOf<(typeof opt)["value"]>().toEqualTypeOf<{ a: number; b?: number }>();
    expectTypeOf<(typeof opt)["value"]["b"]>().toEqualTypeOf<number | undefined>();

    const uni = mutableStore({ ref: null as { k: number } | null });
    expectTypeOf<(typeof uni)["value"]["ref"]>().toEqualTypeOf<{ k: number } | null>();

    const empty = mutableStore({});
    expectTypeOf<(typeof empty)["value"]>().toEqualTypeOf<{}>();
  });

  it("accepts an optional StoreDevtoolsOptions as the second parameter", () => {
    expectTypeOf(mutableStore).parameter(1).toEqualTypeOf<StoreDevtoolsOptions | undefined>();
    expectTypeOf(mutableStore<{ a: number }>).toBeCallableWith({ a: 1 }, { name: "x", key: true });
    expectTypeOf(mutableStore<{ a: number }>).toBeCallableWith({ a: 1 });
  });

  it("BUG(loose): `T extends object` also admits functions/callables (a non-draftable value)", () => {
    // `object` in TS includes functions, so a callable slips past the constraint
    // even though the draft machinery only handles plain objects/arrays.
    // NB: the arrow's return literal is preserved (T = `() => 1`, not `() => number`).
    expectTypeOf(mutableStore(() => 1)).toEqualTypeOf<MutableStore<() => 1>>();
  });

  it("rejects primitive/nullish initials and excess devtools options", () => {
    // Never invoked — declared only so `tsc` type-checks the negative cases.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    function _rejects(): void {
      // @ts-expect-error primitive number is not `object`
      mutableStore(5);
      // @ts-expect-error primitive string is not `object`
      mutableStore("x");
      // @ts-expect-error primitive boolean is not `object`
      mutableStore(true);
      // @ts-expect-error null is not `object`
      mutableStore(null);
      // @ts-expect-error undefined is not `object`
      mutableStore(undefined);
      // @ts-expect-error the initial value is required
      mutableStore();
      // @ts-expect-error unknown devtools option key
      mutableStore({ a: 1 }, { bogus: 1 });
    }
    void _rejects;
  });
});

describe("mutable types — .value is a deeply-mutable T", () => {
  it("resolves to exactly T with all nested fields preserved and mutable", () => {
    const s = mutableStore({ user: { tags: ["x"] }, n: 0 });
    type SVal = (typeof s)["value"];
    expectTypeOf<SVal>().toEqualTypeOf<UserState>();
    expectTypeOf<SVal["user"]>().toEqualTypeOf<{ tags: string[] }>();
    expectTypeOf<SVal["user"]["tags"]>().toEqualTypeOf<string[]>();
    expectTypeOf<SVal["n"]>().toEqualTypeOf<number>();
    // Array element access resolves through the mutable array type.
    expectTypeOf<SVal["user"]["tags"][number]>().toEqualTypeOf<string>();
  });

  it("is a writable property (whole-value reassignment and deep mutation type-check)", () => {
    // Never invoked — `.value` throws without a scope at runtime, but these lines
    // prove the property is writable and deeply mutable at the type level.
    function _writes(): void {
      const s = mutableStore({ user: { tags: ["x"] }, n: 0 });
      s.value = { user: { tags: ["y"] }, n: 1 }; // wholesale replace type-checks
      s.value.n = 2; // leaf write
      s.value.user.tags.push("z"); // deep array mutation
      s.value.user.tags = []; // deep reassignment
    }
    void _writes;
  });

  it("NOTE(type<runtime divergence): a `readonly` field in T stays readonly in the type though the runtime draft is mutable", () => {
    // Never invoked. The runtime proxy would happily accept this write; the type
    // (being exactly T) forbids it. `.value` is `T`, not a `Draft<T>` transform.
    function _readonly(): void {
      const s = mutableStore({ a: 1 } as { readonly a: number });
      // @ts-expect-error readonly field cannot be assigned at the type level
      s.value.a = 2;
    }
    void _readonly;
  });
});

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
});
