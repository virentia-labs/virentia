import { describe, expectTypeOf, it } from "vitest";
import type { Reactive, ReactiveWritable, Store, StoreWritable } from "@virentia/core";
import type { Component } from "vue";
import type {
  CachedComponentConfig,
  ComponentConfig,
  ComponentCreate,
  ComponentModel,
  ComponentPublicProps,
  ComponentView,
  ModelCache,
  ModelFactory,
  ReactiveModel,
  UnitLike,
} from "../../lib";
import type { AnyStore } from "../../lib/types";
import type { AnyStore as InternalAnyStore } from "../../lib/types";

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
type VirentiaComponentAlias = import("../../lib").VirentiaComponent<{ n: number }, { c: Store<number> }>;

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
