import { describe, expectTypeOf, it } from "vitest";
import type { StoreDevtoolsOptions } from "@virentia/core";
import { mutableStore } from "../../lib";
import type { MutableStore } from "../../lib";

// ---------------------------------------------------------------------------
// Type-level tests for @virentia/mutable. Every assertion is a compile-time
// check evaluated by `tsc` under vitest's typecheck run. Because `state.value`
// is a getter that throws without an active scope (see mutable-store.ts
// `scopeOf("read")`), assertions about `.value` use the pure type-argument form
// `expectTypeOf<T>()` / `(typeof x)["value"]` so nothing evaluates `.value` at
// runtime. Method references (`s.map`, `s.subscribe`) and constructor calls are
// runtime-safe.
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
