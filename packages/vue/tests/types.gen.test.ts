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
import type { Component, Ref } from "vue";
import { createModelCache } from "../lib";
import type {
  CachedComponentConfig,
  ComponentConfig,
  ComponentCreate,
  ComponentModel,
  ComponentPublicProps,
  ComponentView,
  ModelCache,
  ModelContext,
  ModelFactory,
  ModelInstance,
  ReactiveModel,
  UnitLike,
  UnitRef,
  UnitShape,
  UnitValue,
} from "../lib";

// `AnyStore` and `CacheOptions` live in types.ts but are not part of the public
// index surface, so pull them directly for the structural/collapse probes.
import type { AnyStore, CacheOptions } from "../lib/types";
import type { AnyStore as InternalAnyStore } from "../lib/types";

// ---------------------------------------------------------------------------
// UnitValue: raw value carried by a unit
// ---------------------------------------------------------------------------
describe("UnitValue", () => {
  it("resolves a writable primitive store to its value type (no Ref, no store shape)", () => {
    expectTypeOf<UnitValue<StoreWritable<boolean>>>().toEqualTypeOf<boolean>();
    expectTypeOf<UnitValue<StoreWritable<string>>>().toEqualTypeOf<string>();
    expectTypeOf<UnitValue<StoreWritable<number>>>().toEqualTypeOf<number>();
  });

  it("resolves a read-only store to its value type", () => {
    expectTypeOf<UnitValue<Store<boolean>>>().toEqualTypeOf<boolean>();
    expectTypeOf<UnitValue<Store<string | null>>>().toEqualTypeOf<string | null>();
  });

  it("resolves object reactives to the object value (not the reactive wrapper)", () => {
    expectTypeOf<UnitValue<Reactive<{ a: number; b: string }>>>().toEqualTypeOf<{
      a: number;
      b: string;
    }>();
    expectTypeOf<UnitValue<ReactiveWritable<{ a: number }>>>().toEqualTypeOf<{ a: number }>();
  });

  it("maps events to a scope-bound callable returning Promise<void>", () => {
    expectTypeOf<UnitValue<EventCallable<string>>>().toEqualTypeOf<
      (payload: string) => Promise<void>
    >();
  });

  it("maps a void event to an optional-payload callable", () => {
    expectTypeOf<UnitValue<EventCallable<void>>>().toEqualTypeOf<
      (payload?: void) => Promise<void>
    >();
  });

  it("maps a union-payload event to a required-payload callable", () => {
    expectTypeOf<UnitValue<EventCallable<string | number>>>().toEqualTypeOf<
      (payload: string | number) => Promise<void>
    >();
  });

  it("maps an optional/undefined-payload event to an optional-payload callable", () => {
    expectTypeOf<UnitValue<EventCallable<string | undefined>>>().toEqualTypeOf<
      (payload?: string | undefined) => Promise<void>
    >();
  });

  it("maps effects to a callable resolving to the Done value", () => {
    expectTypeOf<UnitValue<Effect<number, string, Error>>>().toEqualTypeOf<
      (params: number, options?: EffectCallOptions) => Promise<string>
    >();
  });

  it("resolves a non-unit to never (fallthrough, not an internal leak)", () => {
    expectTypeOf<UnitValue<number>>().toEqualTypeOf<never>();
    expectTypeOf<UnitValue<string>>().toEqualTypeOf<never>();
    expectTypeOf<UnitValue<{ a: number }>>().toEqualTypeOf<never>();
    expectTypeOf<UnitValue<Record<string, never>>>().toEqualTypeOf<never>();
  });

  it("distributes over a union of units", () => {
    expectTypeOf<UnitValue<Store<number> | EventCallable<string>>>().toEqualTypeOf<
      number | ((payload: string) => Promise<void>)
    >();
  });

  it("collapses a union of all four store variants of one value type to that value", () => {
    expectTypeOf<UnitValue<AnyStore<number>>>().toEqualTypeOf<number>();
  });
});

// ---------------------------------------------------------------------------
// UnitRef: how a unit is exposed inside a Vue setup (stores -> refs)
// ---------------------------------------------------------------------------
describe("UnitRef", () => {
  it("exposes primitive stores as Readonly<Ref<value>>", () => {
    expectTypeOf<UnitRef<StoreWritable<boolean>>>().toEqualTypeOf<Readonly<Ref<boolean>>>();
    expectTypeOf<UnitRef<Store<string | null>>>().toEqualTypeOf<Readonly<Ref<string | null>>>();
  });

  it("exposes object reactives as Readonly<Ref<object>>", () => {
    expectTypeOf<UnitRef<Reactive<{ name: string; age: number }>>>().toEqualTypeOf<
      Readonly<Ref<{ name: string; age: number }>>
    >();
    expectTypeOf<UnitRef<ReactiveWritable<{ a: number }>>>().toEqualTypeOf<
      Readonly<Ref<{ a: number }>>
    >();
  });

  it("maps events to scope-bound callables (Vue mirrors the react UnitValue for events)", () => {
    expectTypeOf<UnitRef<EventCallable<string>>>().toEqualTypeOf<
      (payload: string) => Promise<void>
    >();
    expectTypeOf<UnitRef<EventCallable<void>>>().toEqualTypeOf<(payload?: void) => Promise<void>>();
  });

  it("maps effects to callables resolving to Done", () => {
    expectTypeOf<UnitRef<Effect<number, string, Error>>>().toEqualTypeOf<
      (params: number, options?: EffectCallOptions) => Promise<string>
    >();
    expectTypeOf<UnitRef<Effect<void, boolean, unknown>>>().toEqualTypeOf<
      (params: void, options?: EffectCallOptions) => Promise<boolean>
    >();
  });

  it("differs from UnitValue for stores: ref vs bare value", () => {
    expectTypeOf<UnitRef<Store<number>>>().not.toEqualTypeOf<UnitValue<Store<number>>>();
    expectTypeOf<UnitRef<Store<number>>>().toEqualTypeOf<Readonly<Ref<number>>>();
    expectTypeOf<UnitValue<Store<number>>>().toEqualTypeOf<number>();
  });

  it("resolves a non-unit to never (fallthrough)", () => {
    expectTypeOf<UnitRef<number>>().toEqualTypeOf<never>();
    expectTypeOf<UnitRef<{ a: number }>>().toEqualTypeOf<never>();
    expectTypeOf<UnitRef<Record<string, never>>>().toEqualTypeOf<never>();
  });

  it("distributes over a union of units", () => {
    expectTypeOf<UnitRef<Store<number> | EventCallable<string>>>().toEqualTypeOf<
      Readonly<Ref<number>> | ((payload: string) => Promise<void>)
    >();
  });

  it("collapses all four store variants of one value type to a single ref", () => {
    expectTypeOf<UnitRef<AnyStore<number>>>().toEqualTypeOf<Readonly<Ref<number>>>();
  });
});

// ---------------------------------------------------------------------------
// UnitShape: tuple/record binding shapes used by useUnit overloads
// ---------------------------------------------------------------------------
describe("UnitShape", () => {
  it("maps a readonly tuple positionally to a tuple of UnitRef", () => {
    type Shape = UnitShape<readonly [Store<number>, EventCallable<string>]>;
    expectTypeOf<Shape[0]>().toEqualTypeOf<Readonly<Ref<number>>>();
    expectTypeOf<Shape[1]>().toEqualTypeOf<(payload: string) => Promise<void>>();
  });

  it("preserves tuple length/order for three-element tuples", () => {
    type Shape = UnitShape<readonly [Store<boolean>, Effect<number, string, unknown>, Reactive<{ x: 1 }>]>;
    expectTypeOf<Shape[0]>().toEqualTypeOf<Readonly<Ref<boolean>>>();
    expectTypeOf<Shape[1]>().toEqualTypeOf<(params: number, options?: EffectCallOptions) => Promise<string>>();
    expectTypeOf<Shape[2]>().toEqualTypeOf<Readonly<Ref<{ x: 1 }>>>();
  });

  it("maps a record to a record of UnitRef per key", () => {
    type Shape = UnitShape<{ a: Store<number>; go: EventCallable<void> }>;
    expectTypeOf<Shape["a"]>().toEqualTypeOf<Readonly<Ref<number>>>();
    expectTypeOf<Shape["go"]>().toEqualTypeOf<(payload?: void) => Promise<void>>();
  });

  it("resolves non tuple/record inputs to never", () => {
    expectTypeOf<UnitShape<string>>().toEqualTypeOf<never>();
    expectTypeOf<UnitShape<number>>().toEqualTypeOf<never>();
  });
});

// ---------------------------------------------------------------------------
// ReactiveModel: react parity but with UnitRef (stores -> refs)
// ---------------------------------------------------------------------------
describe("ReactiveModel", () => {
  it("exposes primitive store fields as readonly refs", () => {
    type View = ReactiveModel<{ saving: StoreWritable<boolean>; message: Store<string | null> }>;
    expectTypeOf<View["saving"]>().toEqualTypeOf<Readonly<Ref<boolean>>>();
    expectTypeOf<View["message"]>().toEqualTypeOf<Readonly<Ref<string | null>>>();
  });

  it("exposes event/effect fields as scope-bound callables", () => {
    type View = ReactiveModel<{
      submit: EventCallable<string>;
      reset: EventCallable<void>;
      load: Effect<number, string, Error>;
    }>;
    expectTypeOf<View["submit"]>().toEqualTypeOf<(payload: string) => Promise<void>>();
    expectTypeOf<View["reset"]>().toEqualTypeOf<(payload?: void) => Promise<void>>();
    expectTypeOf<View["load"]>().toEqualTypeOf<
      (params: number, options?: EffectCallOptions) => Promise<string>
    >();
  });

  it("omits the string 'dispose' key from the resolved type (T1)", () => {
    type View = ReactiveModel<{ count: Store<number>; dispose(): void }>;
    expectTypeOf<keyof View>().toEqualTypeOf<"count">();
  });

  it("keeps method fields unchanged", () => {
    type View = ReactiveModel<{ run: () => void; compute: (n: number) => string }>;
    expectTypeOf<View["run"]>().toEqualTypeOf<() => void>();
    expectTypeOf<View["compute"]>().toEqualTypeOf<(n: number) => string>();
  });

  it("keeps primitive fields unchanged", () => {
    type View = ReactiveModel<{ label: string; n: number; flag: boolean; u: string | number }>;
    expectTypeOf<View["label"]>().toEqualTypeOf<string>();
    expectTypeOf<View["n"]>().toEqualTypeOf<number>();
    expectTypeOf<View["flag"]>().toEqualTypeOf<boolean>();
    expectTypeOf<View["u"]>().toEqualTypeOf<string | number>();
  });

  it("preserves optional primitive fields as optional (including undefined)", () => {
    type View = ReactiveModel<{ label?: string }>;
    expectTypeOf<View["label"]>().toEqualTypeOf<string | undefined>();
    // The optional modifier survives the mapped type.
    expectTypeOf<{} extends View ? true : false>().toEqualTypeOf<true>();
  });

  it("unwraps units nested at depth while recursing plain objects (T2)", () => {
    type View = ReactiveModel<{
      group: { flag: Store<boolean>; deeper: { count: Store<number> } };
    }>;
    expectTypeOf<View["group"]["flag"]>().toEqualTypeOf<Readonly<Ref<boolean>>>();
    expectTypeOf<View["group"]["deeper"]["count"]>().toEqualTypeOf<Readonly<Ref<number>>>();
  });

  it("keeps array fields RAW to match runtime (no element unwrap)", () => {
    type View = ReactiveModel<{ items: Store<number>[]; tuple: readonly [Store<boolean>] }>;
    expectTypeOf<View["items"]>().toEqualTypeOf<Store<number>[]>();
    expectTypeOf<View["tuple"]>().toEqualTypeOf<readonly [Store<boolean>]>();
  });

  it("passes a ComponentModel field through unchanged (not unwrapped) (T3)", () => {
    type Child = ComponentModel<{ n: Store<number> }>;
    type View = ReactiveModel<{ child: Child }>;
    expectTypeOf<View["child"]>().toEqualTypeOf<ComponentModel<{ n: Store<number> }>>();
    // The child's own units stay raw (not rebound to refs).
    expectTypeOf<View["child"]["n"]>().toEqualTypeOf<Store<number>>();
  });

  it("recurses a plain object while passing a sibling ComponentModel through", () => {
    type Child = ComponentModel<{ n: Store<number> }>;
    type View = ReactiveModel<{ plain: { s: Store<number> }; child: Child }>;
    expectTypeOf<View["plain"]["s"]>().toEqualTypeOf<Readonly<Ref<number>>>();
    expectTypeOf<View["child"]["n"]>().toEqualTypeOf<Store<number>>();
  });

  it("makes every carried key readonly", () => {
    type View = ReactiveModel<{ count: Store<number> }>;
    // Mutating the mapped property must be rejected: the mapped type adds `readonly`.
    expectTypeOf<View>().toEqualTypeOf<{ readonly count: Readonly<Ref<number>> }>();
  });

  it("resolves an empty model to an empty object", () => {
    expectTypeOf<ReactiveModel<{}>>().toEqualTypeOf<{}>();
  });

  it("carries a non-unit object field with a `.node` prop as a NEVER leak (bug: should recurse)", () => {
    type View = ReactiveModel<{ weird: { node: string; label: string } }>;
    // BUG: the `{ readonly node: unknown }` unit-heuristic matches any object that
    // merely has a `node` field. UnitRef then fails every unit branch and leaks
    // `never`. The correct behaviour would be to recurse the plain object.
    // @ts-expect-error documents the never-leak: `weird` resolves to `never`.
    expectTypeOf<View["weird"]>().toEqualTypeOf<{ readonly node: string; readonly label: string }>();
    // Confirm the actual (wrong) resolved type is `never`.
    expectTypeOf<View["weird"]>().toEqualTypeOf<never>();
  });

  it("retains a Symbol.dispose key that runtime buildReactiveModel actually skips (type/runtime divergence)", () => {
    type View = ReactiveModel<{ count: Store<number>; [Symbol.dispose](): void }>;
    // DIVERGENCE: `buildReactiveModel` skips the Symbol.dispose key at runtime, but
    // ReactiveModel only remaps the string "dispose" so the symbol key survives in
    // the type. The correct (runtime-matching) key set is just "count".
    // @ts-expect-error documents that the symbol key is not omitted at the type level.
    expectTypeOf<keyof View>().toEqualTypeOf<"count">();
    // Actual behaviour: the symbol key is retained alongside "count".
    expectTypeOf<keyof View>().toEqualTypeOf<"count" | typeof Symbol.dispose>();
  });
});

// ---------------------------------------------------------------------------
// ComponentModel & DisposableOwner brand
// ---------------------------------------------------------------------------
describe("ComponentModel", () => {
  it("keeps nested units RAW at depth (T7)", () => {
    type CM = ComponentModel<{ inner: { flag: Store<boolean> }; count: Store<number> }>;
    expectTypeOf<CM["inner"]["flag"]>().toEqualTypeOf<Store<boolean>>();
    expectTypeOf<CM["count"]>().toEqualTypeOf<Store<number>>();
  });

  it("is assignable to DisposableOwner (carries dispose + Symbol.dispose)", () => {
    type CM = ComponentModel<{ n: Store<number> }>;
    expectTypeOf<CM>().toMatchTypeOf<DisposableOwner>();
    expectTypeOf<CM["dispose"]>().toEqualTypeOf<() => void>();
    expectTypeOf<CM[typeof Symbol.dispose]>().toEqualTypeOf<() => void>();
  });

  it("preserves the model's own fields", () => {
    type CM = ComponentModel<{ n: Store<number>; label: string }>;
    expectTypeOf<CM["n"]>().toEqualTypeOf<Store<number>>();
    expectTypeOf<CM["label"]>().toEqualTypeOf<string>();
  });
});

// ---------------------------------------------------------------------------
// ModelContext / ModelFactory / ModelInstance
// ---------------------------------------------------------------------------
describe("ModelContext / ModelFactory / ModelInstance", () => {
  it("ModelContext exposes the scoped lifecycle surface", () => {
    type Ctx = ModelContext<{ step: number }, string>;
    expectTypeOf<Ctx["scope"]>().toEqualTypeOf<Scope>();
    expectTypeOf<Ctx["owner"]>().toEqualTypeOf<Owner>();
    expectTypeOf<Ctx["props"]>().toEqualTypeOf<ReactiveWritable<{ step: number }>>();
    expectTypeOf<Ctx["mounted"]>().toEqualTypeOf<EventCallable<void>>();
    expectTypeOf<Ctx["unmounted"]>().toEqualTypeOf<EventCallable<void>>();
    expectTypeOf<Ctx["mounts"]>().toEqualTypeOf<StoreWritable<number>>();
    expectTypeOf<Ctx["key"]>().toEqualTypeOf<string>();
  });

  it("ModelContext key defaults to undefined", () => {
    type Ctx = ModelContext<{ step: number }>;
    expectTypeOf<Ctx["key"]>().toEqualTypeOf<undefined>();
  });

  it("ModelFactory is a context -> model function", () => {
    type Factory = ModelFactory<{ step: number }, { c: Store<number> }, string>;
    expectTypeOf<Factory>().parameter(0).toEqualTypeOf<ModelContext<{ step: number }, string>>();
    expectTypeOf<Factory>().returns.toEqualTypeOf<{ c: Store<number> }>();
  });

  it("ModelFactory key defaults to undefined in the context", () => {
    type Factory = ModelFactory<{ step: number }, { c: Store<number> }>;
    expectTypeOf<Factory>().parameter(0).toEqualTypeOf<ModelContext<{ step: number }, undefined>>();
  });

  it("ModelInstance extends the context and adds model + dispose", () => {
    type Instance = ModelInstance<{ step: number }, { c: Store<number> }, string>;
    expectTypeOf<Instance["model"]>().toEqualTypeOf<{ c: Store<number> }>();
    expectTypeOf<Instance["dispose"]>().toEqualTypeOf<() => void>();
    expectTypeOf<Instance["scope"]>().toEqualTypeOf<Scope>();
    expectTypeOf<Instance["props"]>().toEqualTypeOf<ReactiveWritable<{ step: number }>>();
    expectTypeOf<Instance["key"]>().toEqualTypeOf<string>();
  });
});

// ---------------------------------------------------------------------------
// ModelCache / CacheOptions / createModelCache
// ---------------------------------------------------------------------------
describe("ModelCache / CacheOptions", () => {
  type Key = string;
  type Props = { step: number };
  type Model = { c: Store<number> };
  type Cache = ModelCache<Key, Props, Model>;

  it("has() takes (key, scope?) and returns boolean", () => {
    expectTypeOf<Cache["has"]>().toEqualTypeOf<(key: Key, scope?: Scope) => boolean>();
  });

  it("get() returns the model or undefined", () => {
    expectTypeOf<Cache["get"]>().toEqualTypeOf<(key: Key, scope?: Scope) => Model | undefined>();
  });

  it("getInstance() returns a ModelInstance or undefined", () => {
    expectTypeOf<Cache["getInstance"]>().toEqualTypeOf<
      (key: Key, scope?: Scope) => ModelInstance<Props, Model, Key> | undefined
    >();
  });

  it("delete() returns boolean and clear() returns void", () => {
    expectTypeOf<Cache["delete"]>().toEqualTypeOf<(key: Key, scope?: Scope) => boolean>();
    expectTypeOf<Cache["clear"]>().toEqualTypeOf<(scope?: Scope) => void>();
  });

  it("scope argument is optional on every method", () => {
    expectTypeOf<Cache["has"]>().toBeCallableWith("k");
    expectTypeOf<Cache["get"]>().toBeCallableWith("k");
    expectTypeOf<Cache["delete"]>().toBeCallableWith("k");
    expectTypeOf<Cache["clear"]>().toBeCallableWith();
  });

  it("CacheOptions bundles a matching cache and key", () => {
    type Opts = CacheOptions<Props, Key, Model>;
    expectTypeOf<Opts["cache"]>().toEqualTypeOf<ModelCache<Key, Props, Model>>();
    expectTypeOf<Opts["key"]>().toEqualTypeOf<Key>();
  });

  it("createModelCache returns a ModelCache of the requested generics", () => {
    expectTypeOf<ReturnType<typeof createModelCache<Key, Props, Model>>>().toEqualTypeOf<
      ModelCache<Key, Props, Model>
    >();
  });
});

// ---------------------------------------------------------------------------
// Component-facing types
// ---------------------------------------------------------------------------
describe("Component types", () => {
  type Props = { n: number };
  type Model = { c: Store<number> };

  it("ComponentCreate is callable with props and returns a ComponentModel", () => {
    type Create = ComponentCreate<Props, Model>;
    expectTypeOf<Create>().parameter(0).toEqualTypeOf<Props>();
    expectTypeOf<Create>().returns.toEqualTypeOf<ComponentModel<Model>>();
    expectTypeOf<Create>().toBeCallableWith({ n: 1 });
  });

  it("ComponentPublicProps omits the incoming model and adds an optional branded model", () => {
    type Public = ComponentPublicProps<{ a: number; model: string }, Model>;
    expectTypeOf<Public["a"]>().toEqualTypeOf<number>();
    expectTypeOf<Public["model"]>().toEqualTypeOf<ComponentModel<Model> | undefined>();
    // The `model` key is genuinely optional (a `{}` satisfies just that slot).
    expectTypeOf<{} extends Pick<Public, "model"> ? true : false>().toEqualTypeOf<true>();
  });

  it("VirentiaComponent carries a `create` factory and stays a Vue Component", () => {
    type VC = VirentiaComponentAlias;
    expectTypeOf<VC["create"]>().toEqualTypeOf<ComponentCreate<Props, Model>>();
    expectTypeOf<VC>().toMatchTypeOf<Component<ComponentPublicProps<Props, Model>>>();
  });

  it("ComponentView is a Vue Component keyed by props plus a reactive model", () => {
    expectTypeOf<ComponentView<Props, Model>>().toEqualTypeOf<
      Component<Props & { model: ReactiveModel<Model> }>
    >();
  });

  it("ComponentConfig wires a model factory and a view", () => {
    type Cfg = ComponentConfig<Props, Model>;
    expectTypeOf<Cfg["model"]>().toEqualTypeOf<ModelFactory<Props, Model>>();
    expectTypeOf<Cfg["view"]>().toEqualTypeOf<ComponentView<Props, Model>>();
  });

  it("CachedComponentConfig adds a key selector and a cache", () => {
    type Cfg = CachedComponentConfig<Props, string, Model>;
    expectTypeOf<Cfg["key"]>().toEqualTypeOf<(props: Props) => string>();
    expectTypeOf<Cfg["cache"]>().toEqualTypeOf<ModelCache<string, Props, Model>>();
    expectTypeOf<Cfg["model"]>().toEqualTypeOf<ModelFactory<Props, Model, string>>();
    expectTypeOf<Cfg["view"]>().toEqualTypeOf<ComponentView<Props, Model>>();
  });
});

// Local alias so the VirentiaComponent import stays referenced in a stable spot.
type VirentiaComponentAlias = import("../lib").VirentiaComponent<{ n: number }, { c: Store<number> }>;

// ---------------------------------------------------------------------------
// Collapse / any-leak probes on the helper aliases
// ---------------------------------------------------------------------------
describe("collapse probes", () => {
  it("UnitLike collapses to `any` (ReactiveWritable<any> = any) — documented in ReactiveModel", () => {
    expectTypeOf<UnitLike>().toBeAny();
  });

  it("AnyStore with default (any) parameter collapses to `any`", () => {
    expectTypeOf<AnyStore>().toBeAny();
    expectTypeOf<InternalAnyStore>().toBeAny();
  });

  it("AnyStore<T> for a concrete T is the union of the four store variants (not any)", () => {
    expectTypeOf<AnyStore<number>>().not.toBeAny();
    expectTypeOf<AnyStore<number>>().toEqualTypeOf<
      Store<number> | StoreWritable<number> | Reactive<number> | ReactiveWritable<number>
    >();
  });
});
