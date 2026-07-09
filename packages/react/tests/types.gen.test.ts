import { describe, expectTypeOf, it } from "vitest";
import type {
  DisposableOwner,
  Effect,
  EffectCallOptions,
  EventCallable,
  Owner,
  Reactive,
  ReactiveWritable,
  Scope,
  Store,
  StoreWritable,
} from "@virentia/core";
import type { ComponentType } from "react";
import type {
  ComponentCreate,
  ComponentModel,
  ComponentPublicProps,
  ModelCache,
  ModelContext,
  ModelFactory,
  ModelInstance,
  ReactiveModel,
  UnitLike,
  UnitValue,
  VirentiaComponent,
} from "../lib";
// These utilities are intentionally not re-exported from the package barrel, so
// pull them straight from the source module to exercise them directly.
import type {
  CachedComponentConfig,
  ComponentConfig,
  UnitShape,
} from "../lib/types";

// ---------------------------------------------------------------------------
// UnitValue<Unit>
// ---------------------------------------------------------------------------

describe("UnitValue store unwrapping", () => {
  it("unwraps every AnyStore flavour to its state (primitive)", () => {
    expectTypeOf<UnitValue<Store<number>>>().toEqualTypeOf<number>();
    expectTypeOf<UnitValue<StoreWritable<number>>>().toEqualTypeOf<number>();
  });

  it("unwraps reactive object stores to the raw object state (no StoreApi leak)", () => {
    expectTypeOf<UnitValue<Reactive<{ name: string; age: number }>>>().toEqualTypeOf<{
      name: string;
      age: number;
    }>();
    expectTypeOf<UnitValue<ReactiveWritable<{ id: string }>>>().toEqualTypeOf<{ id: string }>();
  });

  it("does not leak the store API when the state itself is an object", () => {
    // Regression guard: a distributive `T extends object` used to fold the whole
    // `{ value: T } & StoreApi<T>` shape into the resolved type.
    expectTypeOf<UnitValue<Store<{ deep: number }>>>().toEqualTypeOf<{ deep: number }>();
    expectTypeOf<UnitValue<StoreWritable<{ deep: number }>>>().toEqualTypeOf<{ deep: number }>();
    expectTypeOf<UnitValue<Store<number[]>>>().toEqualTypeOf<number[]>();
  });

  it("preserves union and nullable/undefined state without collapsing", () => {
    expectTypeOf<UnitValue<Store<string | null>>>().toEqualTypeOf<string | null>();
    expectTypeOf<UnitValue<Store<number | string>>>().toEqualTypeOf<number | string>();
    expectTypeOf<UnitValue<Store<undefined>>>().toEqualTypeOf<undefined>();
    expectTypeOf<UnitValue<StoreWritable<boolean>>>().toEqualTypeOf<boolean>();
  });
});

describe("UnitValue event unwrapping", () => {
  it("unwraps a payload event to a scoped async caller", () => {
    expectTypeOf<UnitValue<EventCallable<string>>>().toEqualTypeOf<
      (payload: string) => Promise<void>
    >();
  });

  it("unwraps a void event to a no-argument caller (EventPayload<void> is [payload?: void])", () => {
    expectTypeOf<UnitValue<EventCallable<void>>>().toEqualTypeOf<
      (payload?: void) => Promise<void>
    >();
    expectTypeOf<UnitValue<EventCallable<void>>>().toBeCallableWith(undefined);
    expectTypeOf<UnitValue<EventCallable<void>>>().returns.toEqualTypeOf<Promise<void>>();
  });

  it("keeps the payload optional when the payload type admits undefined", () => {
    expectTypeOf<UnitValue<EventCallable<string | undefined>>>().toEqualTypeOf<
      (payload?: string | undefined) => Promise<void>
    >();
  });

  it("keeps a union payload as a single required argument", () => {
    expectTypeOf<UnitValue<EventCallable<number | string>>>().toEqualTypeOf<
      (payload: number | string) => Promise<void>
    >();
    expectTypeOf<UnitValue<EventCallable<{ a: number }>>>().parameter(0).toEqualTypeOf<{
      a: number;
    }>();
  });
});

describe("UnitValue effect unwrapping", () => {
  it("unwraps an effect to (params, options?) => Promise<Done> (EffectCallArgs)", () => {
    type Fx = UnitValue<Effect<number, string, unknown>>;
    expectTypeOf<Fx>().parameter(0).toEqualTypeOf<number>();
    expectTypeOf<Fx>().parameter(1).toEqualTypeOf<EffectCallOptions | undefined>();
    expectTypeOf<Fx>().returns.toEqualTypeOf<Promise<string>>();
  });

  it("keeps the second options argument optional and callable both ways", () => {
    type Fx = UnitValue<Effect<number, string, unknown>>;
    expectTypeOf<Fx>().toBeCallableWith(1);
    expectTypeOf<Fx>().toBeCallableWith(1, {});
    expectTypeOf<Fx>().toBeCallableWith(1, { signal: new AbortController().signal });
  });

  it("unwraps a void-params / void-done effect", () => {
    type Fx = UnitValue<Effect<void, void, unknown>>;
    expectTypeOf<Fx>().toEqualTypeOf<(params: void, options?: EffectCallOptions) => Promise<void>>();
    expectTypeOf<Fx>().returns.toEqualTypeOf<Promise<void>>();
    expectTypeOf<Fx>().toBeCallableWith(undefined);
  });
});

describe("UnitValue edge cases (never-leak / distributivity probes)", () => {
  it("resolves to never for anything that is not a unit", () => {
    expectTypeOf<UnitValue<{}>>().toBeNever();
    expectTypeOf<UnitValue<{ node: string }>>().toBeNever();
    expectTypeOf<UnitValue<string>>().toBeNever();
    expectTypeOf<UnitValue<number>>().toBeNever();
    expectTypeOf<UnitValue<() => void>>().toBeNever();
    expectTypeOf<UnitValue<{ name: string; age: number }>>().toBeNever();
  });

  it("distributes over unions of units", () => {
    expectTypeOf<UnitValue<Store<number> | EventCallable<string>>>().toEqualTypeOf<
      number | ((payload: string) => Promise<void>)
    >();
    expectTypeOf<UnitValue<Store<number> | Store<string>>>().toEqualTypeOf<number | string>();
  });

  it("resolves never for the never input (empty distribution)", () => {
    expectTypeOf<UnitValue<never>>().toBeNever();
  });
});

// ---------------------------------------------------------------------------
// UnitLike
// ---------------------------------------------------------------------------

describe("UnitLike", () => {
  it("collapses to any (documented: ReactiveWritable<any> = any & ... = any)", () => {
    // This is why ReactiveModel discriminates units by their `.node` marker
    // rather than by `Model[Key] extends UnitLike`.
    expectTypeOf<UnitLike>().toBeAny();
  });
});

// ---------------------------------------------------------------------------
// UnitShape<Shape>
// ---------------------------------------------------------------------------

describe("UnitShape", () => {
  it("maps a tuple positionally to per-element UnitValue", () => {
    type S = UnitShape<readonly [Store<number>, EventCallable<string>]>;
    expectTypeOf<S>().toEqualTypeOf<readonly [number, (payload: string) => Promise<void>]>();
    expectTypeOf<S[0]>().toEqualTypeOf<number>();
    expectTypeOf<S[1]>().toEqualTypeOf<(payload: string) => Promise<void>>();
  });

  it("maps a record to per-key UnitValue (keeping keys)", () => {
    type S = UnitShape<{ count: Store<number>; done: EventCallable<void>; fx: Effect<string, boolean, unknown> }>;
    expectTypeOf<S["count"]>().toEqualTypeOf<number>();
    expectTypeOf<S["done"]>().toEqualTypeOf<(payload?: void) => Promise<void>>();
    expectTypeOf<S["fx"]>().parameter(0).toEqualTypeOf<string>();
    expectTypeOf<S["fx"]>().returns.toEqualTypeOf<Promise<boolean>>();
  });

  it("resolves to never for a non-tuple, non-record shape", () => {
    expectTypeOf<UnitShape<number>>().toBeNever();
    expectTypeOf<UnitShape<string>>().toBeNever();
    expectTypeOf<UnitShape<boolean>>().toBeNever();
  });

  it("maps the empty tuple to the empty tuple", () => {
    expectTypeOf<UnitShape<readonly []>>().toEqualTypeOf<readonly []>();
  });
});

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

  it("omits the `dispose` key entirely and marks the rest readonly", () => {
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

// ---------------------------------------------------------------------------
// ComponentModel<Model>
// ---------------------------------------------------------------------------

describe("ComponentModel", () => {
  type Model = { count: StoreWritable<number>; nested: { deep: { count: StoreWritable<number> } } };
  type CM = ComponentModel<Model>;

  it("keeps unit fields raw at depth", () => {
    expectTypeOf<CM["count"]>().toEqualTypeOf<StoreWritable<number>>();
    expectTypeOf<CM["nested"]["deep"]["count"]>().toEqualTypeOf<StoreWritable<number>>();
  });

  it("is assignable to the underlying Model and to DisposableOwner", () => {
    expectTypeOf<CM>().toMatchTypeOf<Model>();
    expectTypeOf<CM>().toMatchTypeOf<DisposableOwner>();
  });

  it("carries a nominal brand — a bare Model & DisposableOwner is NOT a ComponentModel", () => {
    expectTypeOf<Model & DisposableOwner>().not.toMatchTypeOf<CM>();
    expectTypeOf<Model>().not.toMatchTypeOf<CM>();
  });
});

// ---------------------------------------------------------------------------
// ComponentCreate / ComponentPublicProps / VirentiaComponent
// ---------------------------------------------------------------------------

describe("ComponentCreate", () => {
  type Create = ComponentCreate<{ a: number }, { count: StoreWritable<number> }>;

  it("takes Props and returns ComponentModel<Model>", () => {
    expectTypeOf<Create>().parameter(0).toEqualTypeOf<{ a: number }>();
    expectTypeOf<Create>().returns.toEqualTypeOf<ComponentModel<{ count: StoreWritable<number> }>>();
    expectTypeOf<Create>().toBeCallableWith({ a: 1 });
  });
});

describe("ComponentPublicProps", () => {
  type P = ComponentPublicProps<{ a: number; model: string }, { count: StoreWritable<number> }>;

  it("omits the incoming `model` prop and replaces it with an optional controlled ComponentModel", () => {
    expectTypeOf<P["a"]>().toEqualTypeOf<number>();
    expectTypeOf<P["model"]>().toEqualTypeOf<
      ComponentModel<{ count: StoreWritable<number> }> | undefined
    >();
  });
});

describe("VirentiaComponent", () => {
  type VCmp = VirentiaComponent<{ a: number }, { count: StoreWritable<number> }>;

  it("exposes a `create` factory equal to ComponentCreate", () => {
    expectTypeOf<VCmp["create"]>().toEqualTypeOf<
      ComponentCreate<{ a: number }, { count: StoreWritable<number> }>
    >();
    expectTypeOf<VCmp["create"]>().parameter(0).toEqualTypeOf<{ a: number }>();
    expectTypeOf<VCmp["create"]>().returns.toEqualTypeOf<
      ComponentModel<{ count: StoreWritable<number> }>
    >();
    expectTypeOf<VCmp["create"]>().toBeCallableWith({ a: 1 });
  });
});

// ---------------------------------------------------------------------------
// ModelContext / ModelFactory / ModelInstance / ModelCache
// ---------------------------------------------------------------------------

describe("ModelContext", () => {
  type Ctx = ModelContext<{ a: number }, string>;

  it("exposes the framework-managed units at their exact types", () => {
    expectTypeOf<Ctx["scope"]>().toEqualTypeOf<Scope>();
    expectTypeOf<Ctx["owner"]>().toEqualTypeOf<Owner>();
    expectTypeOf<Ctx["props"]>().toEqualTypeOf<ReactiveWritable<{ a: number }>>();
    expectTypeOf<Ctx["mounted"]>().toEqualTypeOf<EventCallable<void>>();
    expectTypeOf<Ctx["unmounted"]>().toEqualTypeOf<EventCallable<void>>();
    expectTypeOf<Ctx["mounts"]>().toEqualTypeOf<StoreWritable<number>>();
    expectTypeOf<Ctx["key"]>().toEqualTypeOf<string>();
  });

  it("defaults the key to undefined", () => {
    expectTypeOf<ModelContext<{ a: number }>["key"]>().toEqualTypeOf<undefined>();
  });
});

describe("ModelFactory", () => {
  it("is (context: ModelContext<Props, Key>) => Model", () => {
    type F = ModelFactory<{ a: number }, { count: StoreWritable<number> }, string>;
    expectTypeOf<F>().parameter(0).toEqualTypeOf<ModelContext<{ a: number }, string>>();
    expectTypeOf<F>().returns.toEqualTypeOf<{ count: StoreWritable<number> }>();
  });

  it("defaults the key to undefined in the context param", () => {
    type F = ModelFactory<{ a: number }, { count: StoreWritable<number> }>;
    expectTypeOf<F>().parameter(0).toEqualTypeOf<ModelContext<{ a: number }, undefined>>();
  });
});

describe("ModelInstance", () => {
  type Inst = ModelInstance<{ a: number }, { count: StoreWritable<number> }, string>;

  it("extends ModelContext and adds model + dispose", () => {
    expectTypeOf<Inst["model"]>().toEqualTypeOf<{ count: StoreWritable<number> }>();
    expectTypeOf<Inst["props"]>().toEqualTypeOf<ReactiveWritable<{ a: number }>>();
    expectTypeOf<Inst["key"]>().toEqualTypeOf<string>();
    expectTypeOf<Inst["dispose"]>().toEqualTypeOf<() => void>();
  });
});

describe("ModelCache", () => {
  type Cache = ModelCache<string, { a: number }, { count: StoreWritable<number> }>;

  it("has key-parameterised accessors with the model as the value type", () => {
    expectTypeOf<Cache["has"]>().parameter(0).toEqualTypeOf<string>();
    expectTypeOf<Cache["has"]>().returns.toEqualTypeOf<boolean>();
    expectTypeOf<Cache["get"]>().parameter(0).toEqualTypeOf<string>();
    expectTypeOf<Cache["get"]>().returns.toEqualTypeOf<{ count: StoreWritable<number> } | undefined>();
    expectTypeOf<Cache["getInstance"]>().returns.toEqualTypeOf<
      ModelInstance<{ a: number }, { count: StoreWritable<number> }, string> | undefined
    >();
    expectTypeOf<Cache["delete"]>().returns.toEqualTypeOf<boolean>();
    expectTypeOf<Cache["clear"]>().returns.toEqualTypeOf<void>();
  });
});

// ---------------------------------------------------------------------------
// ComponentConfig / CachedComponentConfig
// ---------------------------------------------------------------------------

describe("ComponentConfig", () => {
  type Cfg = ComponentConfig<{ a: number }, { count: StoreWritable<number> }>;

  it("pairs a ModelFactory with a view typed over the reactive model", () => {
    expectTypeOf<Cfg["model"]>().toEqualTypeOf<
      ModelFactory<{ a: number }, { count: StoreWritable<number> }>
    >();
    expectTypeOf<Cfg["view"]>().toEqualTypeOf<
      ComponentType<{ a: number } & { model: ReactiveModel<{ count: StoreWritable<number> }> }>
    >();
  });
});

describe("CachedComponentConfig", () => {
  type CCfg = CachedComponentConfig<{ a: number }, string, { count: StoreWritable<number> }>;

  it("adds a keyed cache and threads Key through the factory", () => {
    expectTypeOf<CCfg["key"]>().toEqualTypeOf<(props: { a: number }) => string>();
    expectTypeOf<CCfg["model"]>().toEqualTypeOf<
      ModelFactory<{ a: number }, { count: StoreWritable<number> }, string>
    >();
    expectTypeOf<CCfg["cache"]>().toEqualTypeOf<
      ModelCache<string, { a: number }, { count: StoreWritable<number> }>
    >();
    expectTypeOf<CCfg["view"]>().toEqualTypeOf<
      ComponentType<{ a: number } & { model: ReactiveModel<{ count: StoreWritable<number> }> }>
    >();
  });
});
