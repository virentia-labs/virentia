import { describe, expectTypeOf, it } from "vitest";
import { getOwner, onCleanup, owner, withOwner } from "../../lib";
import type { Cleanup, Owned, Owner } from "../../lib";
import { context, node } from "../../lib/internal";

describe("owner types", () => {
  it("infers owner / getOwner / onCleanup / withOwner", () => {
    const result = owner(() => ({ value: 1 }));
    expectTypeOf(result).toEqualTypeOf<Owned<{ value: number }>>();
    // Owned adds disposal but keeps the wrapped members.
    expectTypeOf(result.value).toEqualTypeOf<number>();
    expectTypeOf(result.dispose).toEqualTypeOf<() => void>();

    expectTypeOf(getOwner()).toEqualTypeOf<Owner | null>();
    expectTypeOf(onCleanup(() => {})).toEqualTypeOf<() => void>();
    expectTypeOf<Cleanup>().toEqualTypeOf<() => void>();
    expectTypeOf<Owner>().toMatchTypeOf<{ readonly disposed: boolean; dispose(): void }>();

    // withOwner threads the callback return type through.
    expectTypeOf(withOwner(null, () => 42)).toEqualTypeOf<number>();
  });
});

describe("type-level contracts", () => {
  it("yields Owned<T> for objects and plain T for primitives", () => {
    const m = owner(() => ({ v: 1 }));
    const p = owner(() => 5);

    expectTypeOf(m).toEqualTypeOf<Owned<{ v: number }>>();
    expectTypeOf(m).toHaveProperty("dispose");
    expectTypeOf(p).toEqualTypeOf<number>();
  });

  it("types context.get() no-fallback and fallback overloads as T", () => {
    const c = context<string>();

    expectTypeOf(c.get()).toEqualTypeOf<string>();
    expectTypeOf(c.get("x")).toEqualTypeOf<string>();
    expectTypeOf(c.get).parameter(0).toEqualTypeOf<string>();
  });

  it("types node() over a fn, options, or nothing", () => {
    expectTypeOf(node((_ctx) => 1)).toMatchTypeOf<{ run?: unknown }>();
    expectTypeOf(node({ run() {}, next: [] })).toMatchTypeOf<{ run?: unknown }>();
    expectTypeOf(node()).toMatchTypeOf<{ run?: unknown }>();
  });
});
