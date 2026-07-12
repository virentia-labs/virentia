import { describe, expectTypeOf, it } from "vitest";
import { event, store } from "@virentia/core";
import type {
  Effect,
  EffectCallOptions,
  EventCallable,
  Reactive,
  ReactiveWritable,
  Store,
  StoreWritable,
} from "@virentia/core";
import type { ComponentModel, ReactiveModel } from "../../lib";

// ---------------------------------------------------------------------------
// ReactiveModel<Model>
// ---------------------------------------------------------------------------

describe("ReactiveModel field unwrapping", () => {
  type Mixed = {
    count: StoreWritable<number>;
    user: Reactive<{ name: string; age: number }>;
    submit: EventCallable<string>;
    load: Effect<number, string, unknown>;
    label: string;
    flag: boolean;
    nothing: null;
    inc: (n: number) => void;
    items: StoreWritable<number>[];
    nested: { a: { b: StoreWritable<boolean> } };
    dispose: () => void;
  };
  type V = ReactiveModel<Mixed>;

  it("unwraps top-level primitive stores to their value", () => {
    expectTypeOf<V["count"]>().toEqualTypeOf<number>();
  });

  it("unwraps reactive object fields to their state", () => {
    expectTypeOf<V["user"]>().toEqualTypeOf<{ name: string; age: number }>();
  });

  it("unwraps event fields to callers", () => {
    expectTypeOf<V["submit"]>().toEqualTypeOf<(payload: string) => Promise<void>>();
  });

  it("unwraps effect fields to callers with EffectCallArgs", () => {
    expectTypeOf<V["load"]>().parameter(0).toEqualTypeOf<number>();
    expectTypeOf<V["load"]>().parameter(1).toEqualTypeOf<EffectCallOptions | undefined>();
    expectTypeOf<V["load"]>().returns.toEqualTypeOf<Promise<string>>();
  });

  it("keeps primitives unchanged", () => {
    expectTypeOf<V["label"]>().toEqualTypeOf<string>();
    expectTypeOf<V["flag"]>().toEqualTypeOf<boolean>();
    expectTypeOf<V["nothing"]>().toEqualTypeOf<null>();
  });

  it("keeps plain method fields unchanged (by identity)", () => {
    expectTypeOf<V["inc"]>().toEqualTypeOf<(n: number) => void>();
  });

  it("keeps array-of-store fields RAW — inner stores are not unwrapped (matches runtime UM13)", () => {
    expectTypeOf<V["items"]>().toEqualTypeOf<StoreWritable<number>[]>();
  });

  it("recurses plain objects and keeps them readonly at depth", () => {
    expectTypeOf<V["nested"]>().toEqualTypeOf<{ readonly a: { readonly b: boolean } }>();
    expectTypeOf<V["nested"]["a"]["b"]>().toEqualTypeOf<boolean>();
  });

  it("omits the `dispose` key while marking the rest readonly", () => {
    expectTypeOf<keyof V>().toEqualTypeOf<
      "count" | "user" | "submit" | "load" | "label" | "flag" | "nothing" | "inc" | "items" | "nested"
    >();
  });

  it("produces a fully readonly shape for a single-store model", () => {
    expectTypeOf<ReactiveModel<{ count: StoreWritable<number> }>>().toEqualTypeOf<{
      readonly count: number;
    }>();
  });
});

describe("ReactiveModel nesting depth 1..4", () => {
  it("unwraps units nested up to depth 4", () => {
    type Deep = { a: { b: { c: { d: StoreWritable<number> } } } };
    type V = ReactiveModel<Deep>;
    expectTypeOf<V["a"]["b"]["c"]["d"]>().toEqualTypeOf<number>();
    expectTypeOf<V["a"]>().toEqualTypeOf<{
      readonly b: { readonly c: { readonly d: number } };
    }>();
  });
});

describe("ReactiveModel array/tuple fields stay raw", () => {
  it("keeps a mutable array of stores raw", () => {
    expectTypeOf<ReactiveModel<{ items: Store<number>[] }>["items"]>().toEqualTypeOf<
      Store<number>[]
    >();
  });

  it("keeps a readonly array of stores raw", () => {
    expectTypeOf<ReactiveModel<{ items: readonly Store<number>[] }>["items"]>().toEqualTypeOf<
      readonly Store<number>[]
    >();
  });

  it("keeps a tuple of units raw (elements NOT unwrapped)", () => {
    expectTypeOf<
      ReactiveModel<{ pair: [Store<number>, EventCallable<string>] }>["pair"]
    >().toEqualTypeOf<[Store<number>, EventCallable<string>]>();
  });
});

describe("ReactiveModel keeps nested ComponentModel raw", () => {
  type Child = ComponentModel<{ count: StoreWritable<number>; nested: { flag: Store<boolean> } }>;
  type V = ReactiveModel<{ child: Child }>;

  it("keeps a ComponentModel-typed field as ComponentModel<ChildModel> (not unwrapped)", () => {
    expectTypeOf<V["child"]>().toEqualTypeOf<Child>();
  });

  it("keeps units inside a nested ComponentModel raw at depth", () => {
    expectTypeOf<V["child"]["count"]>().toEqualTypeOf<StoreWritable<number>>();
    expectTypeOf<V["child"]["nested"]["flag"]>().toEqualTypeOf<Store<boolean>>();
  });
});

describe("ReactiveModel divergence probes (documented type bugs)", () => {
  it("FIXED: optional unit fields are unwrapped to `value | undefined`", () => {
    // A distributive `ResolveReactiveField<V>` unwraps each member, so an optional
    // unit field resolves to `number | undefined` (matching the runtime) instead
    // of leaving the raw `StoreWritable<number> | undefined`.
    expectTypeOf<ReactiveModel<{ count?: StoreWritable<number> }>["count"]>().toEqualTypeOf<
      number | undefined
    >();
  });

  it("BUG: a plain object that merely has a `node` field is misread as a unit and collapses to never", () => {
    // The `.node` heuristic false-positives here; `UnitValue` of a non-unit is
    // `never`, so the field leaks `never`. Runtime keeps it as a recursed object.
    // @ts-expect-error documents the never-leak: the runtime-correct object type fails.
    expectTypeOf<ReactiveModel<{ fake: { node: string; other: number } }>["fake"]>().toEqualTypeOf<{ readonly node: string; readonly other: number }>();
    // Actual (buggy) resolved type:
    expectTypeOf<ReactiveModel<{ fake: { node: string; other: number } }>["fake"]>().toBeNever();
  });
});

describe("ReactiveModel (smoke)", () => {
  // TODO(phase-2 dedup): overlaps "omits the `dispose` key while marking the rest readonly"
  it("omits dispose, keeps a nested ComponentModel raw, and leaves arrays un-unwrapped", () => {
    type WithDispose = ReactiveModel<{ count: Store<number>; dispose: () => void }>;
    expectTypeOf<keyof WithDispose>().toEqualTypeOf<"count">();

    type WithChild = ReactiveModel<{ child: ComponentModel<{ count: Store<number> }> }>;
    expectTypeOf<WithChild["child"]>().toEqualTypeOf<ComponentModel<{ count: Store<number> }>>();

    // TY14 / SUSPECTED TYPE-RUNTIME DIVERGENCE: at runtime (UM13) an array field
    // is kept RAW because `isPlainObject` rejects arrays, so its inner stores are
    // NOT unwrapped. The ReactiveModel TYPE, however, recurses into arrays (they
    // satisfy `Model[Key] extends object`), resolving to
    // `ReactiveModel<Store<number>[]>` — neither the raw `Store<number>[]` the
    // runtime yields nor a cleanly-unwrapped `number[]`. Documented, not asserted
    // as correct.
    type WithArray = ReactiveModel<{ items: Store<number>[] }>;
    expectTypeOf<WithArray["items"]>().toEqualTypeOf<Store<number>[]>();
    expectTypeOf<WithArray["items"]>().not.toEqualTypeOf<number[]>();
  });
});

// ---------------------------------------------------------------------------
// Overlapping subset originally in types.test.ts
// ---------------------------------------------------------------------------

describe("ReactiveModel (runtime-value probes)", () => {
  // TODO(phase-2 dedup): overlaps "unwraps top-level primitive stores to their value"
  it("unwraps primitive store fields", () => {
    const saving = store(false);
    const message = store<string | null>(null);
    const model = { saving, message };
    type View = ReactiveModel<typeof model>;
    expectTypeOf<View["saving"]>().toEqualTypeOf<boolean>();
    expectTypeOf<View["message"]>().toEqualTypeOf<string | null>();
  });

  // TODO(phase-2 dedup): overlaps "unwraps units nested up to depth 4"
  it("unwraps nested units at depth and preserves methods/primitives", () => {
    // Regression: `UnitLike` collapses to `any` (via `ReactiveWritable<any>`), so
    // the unit branch was always taken and every non-top-level-unit field —
    // nested objects, methods, primitives — resolved to `never`. Units are now
    // discriminated by their `.node` marker.
    const model = {
      count: store(0),
      changed: event<number>(),
      inc: () => {},
      label: "hi" as string,
      nested: { count: store(0), deep: { count: store(0) } },
    };
    type View = ReactiveModel<typeof model>;
    expectTypeOf<View["count"]>().toEqualTypeOf<number>();
    expectTypeOf<View["changed"]>().toEqualTypeOf<(payload: number) => Promise<void>>();
    expectTypeOf<View["inc"]>().toEqualTypeOf<() => void>();
    expectTypeOf<View["label"]>().toEqualTypeOf<string>();
    expectTypeOf<View["nested"]["count"]>().toEqualTypeOf<number>();
    expectTypeOf<View["nested"]["deep"]["count"]>().toEqualTypeOf<number>();
  });
});
