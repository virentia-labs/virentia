import { describe, expectTypeOf, it } from "vitest";
import { computed, reactive, readonlyReactive, store } from "../../lib";
import type {
  Node,
  Reactive,
  ReactiveWritable,
  Scope,
  Store,
  StoreDevtoolsOptions,
  StoreSubscriber,
  StoreWritable,
} from "../../lib";

describe("store types", () => {
  it("infers writable/readonly store shapes and .value", () => {
    expectTypeOf(store(0)).toEqualTypeOf<StoreWritable<number>>();
    expectTypeOf(store("x")).toEqualTypeOf<StoreWritable<string>>();

    // `.value` is `number` and writable on a StoreWritable, readonly on a Store.
    expectTypeOf<StoreWritable<number>["value"]>().toEqualTypeOf<number>();
    expectTypeOf<Store<number>["value"]>().toEqualTypeOf<number>();
    expectTypeOf<StoreWritable<number>["value"]>().not.toEqualTypeOf<string>();

    // `writable` narrows to the literal `true` on writable variants.
    expectTypeOf<StoreWritable<number>["writable"]>().toEqualTypeOf<true>();
    expectTypeOf<Store<number>["writable"]>().toEqualTypeOf<boolean>();

    // A StoreWritable is assignable to the readonly Store view.
    expectTypeOf<StoreWritable<number>>().toMatchTypeOf<Store<number>>();

    if (false as boolean) {
      const rw = store(0);
      rw.value = 5; // writable: OK

      const ro: Store<number> = store(0);
      // @ts-expect-error Store.value is readonly and cannot be assigned.
      ro.value = 5;
    }
  });

  it("infers computed shapes", () => {
    expectTypeOf(computed(() => 1)).toEqualTypeOf<Store<number>>();
    expectTypeOf(computed(() => "x")).toEqualTypeOf<Store<string>>();
    // computed with a skipToken keeps the value type.
    expectTypeOf(computed(() => 1, -1)).toEqualTypeOf<Store<number>>();
    expectTypeOf<Store<number>["value"]>().toEqualTypeOf<number>();
  });

  it("infers map/filter/filterMap return types", () => {
    // `.map` produces a readonly Store<Next>; `.filter` preserves T; `.filterMap`
    // produces Store<Next> and REQUIRES a skipToken (second arg).
    expectTypeOf(store(0).map((v) => v.toString())).toEqualTypeOf<Store<string>>();
    expectTypeOf(store(0).map((v) => v > 0)).toEqualTypeOf<Store<boolean>>();
    expectTypeOf(store(0).filter((v) => v > 0)).toEqualTypeOf<Store<number>>();
    expectTypeOf(store(0).filterMap((v) => String(v), "")).toEqualTypeOf<Store<string>>();
    // chained maps keep threading the type.
    expectTypeOf(store(0).map((v) => v > 0).map((b) => String(b))).toEqualTypeOf<Store<string>>();

    if (false as boolean) {
      // @ts-expect-error filterMap requires the skipToken argument.
      store(0).filterMap((v) => String(v));
    }
  });

  it("infers reactive / readonlyReactive shapes", () => {
    expectTypeOf(reactive({ count: 0 })).toEqualTypeOf<ReactiveWritable<{ count: number }>>();
    expectTypeOf(readonlyReactive({ count: 0 })).toEqualTypeOf<Reactive<{ count: number }>>();
    // Object fields are exposed directly (no `.value` indirection).
    expectTypeOf<ReactiveWritable<{ count: number }>["count"]>().toEqualTypeOf<number>();
    expectTypeOf<Reactive<{ count: number }>["count"]>().toEqualTypeOf<number>();
    expectTypeOf<ReactiveWritable<{ count: number }>["writable"]>().toEqualTypeOf<true>();

    // reactive requires an object type.
    if (false as boolean) {
      // @ts-expect-error primitives are not valid reactive state.
      reactive(1);
    }
  });

  it("BUG: reactive field colliding with a StoreApi member is corrupted", () => {
    // A reactive object whose field is named like a StoreApi member (`node`,
    // `map`, `subscribe`, ...) collides under the `T & StoreApi<T>` intersection.
    // Reading `.node` yields `string & Node` (effectively unusable), NOT `string`.
    expectTypeOf<ReactiveWritable<{ node: string }>["node"]>().toEqualTypeOf<string & Node>();
    // @ts-expect-error KNOWN BUG: field type is silently clobbered to `string & Node`.
    expectTypeOf<ReactiveWritable<{ node: string }>["node"]>().toEqualTypeOf<string>();
  });

  it("exposes StoreApi members and devtools options", () => {
    expectTypeOf(store(0).node).toEqualTypeOf<Node>();
    expectTypeOf<StoreSubscriber<number>>().toEqualTypeOf<(value: number, scope: Scope) => void>();
    expectTypeOf<StoreDevtoolsOptions>().toEqualTypeOf<{ name?: string; key?: boolean }>();
    // subscribe returns an unsubscribe function.
    expectTypeOf<Store<number>["subscribe"]>().returns.toEqualTypeOf<() => void>();
  });
});
