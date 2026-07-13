import type {
  DisposableOwner,
  Effect,
  EffectCallArgs,
  EventCallable,
  EventPayload,
  Owner,
  Reactive,
  ReactiveWritable,
  Scope,
  Store,
  StoreWritable,
} from "@virentia/core";
import type { Component, Ref } from "vue";

export type AnyStore<State = any> =
  | Store<State>
  | StoreWritable<State>
  | Reactive<State>
  | ReactiveWritable<State>;

export type UnitLike = AnyStore | EventCallable<any> | Effect<any, any, any>;

declare const componentModelBrand: unique symbol;

/** Raw value a unit carries: store state, or the bound callable for an
 * event/effect. Mirrors `@virentia/react`'s `UnitValue`. */
export type UnitValue<Unit> =
  Unit extends AnyStore<infer State>
    ? State
    : Unit extends EventCallable<infer Payload>
      ? (...payload: EventPayload<Payload>) => Promise<void>
      : Unit extends Effect<infer Params, infer Done, any>
        ? (...args: EffectCallArgs<Params>) => Promise<Done>
        : never;

/** How a unit is exposed inside a Vue setup: stores become reactive refs,
 * events/effects become scope-bound callables. */
export type UnitRef<Unit> =
  Unit extends AnyStore<infer State>
    ? Readonly<Ref<State>>
    : Unit extends EventCallable<infer Payload>
      ? (...payload: EventPayload<Payload>) => Promise<void>
      : Unit extends Effect<infer Params, infer Done, any>
        ? (...args: EffectCallArgs<Params>) => Promise<Done>
        : never;

type ShapeInput = readonly unknown[] | Record<string, unknown>;

/** A value that declares its bindable shape to `useUnit`/`useModel` through a
 * `@@shape` property — the shape object directly, or a method returning it
 * (effector `@@unitShape` compatible). */
export type ShapeSource = {
  readonly ["@@shape"]: ShapeInput | (() => ShapeInput);
};

/** Resolves a shape to what `useUnit` yields in a Vue setup: units become refs
 * or bound callables, `@@shape` declarations are unwrapped, and arrays/records
 * are mapped recursively so nesting resolves to any depth. */
export type Bound<T> = T extends { readonly ["@@shape"]: infer S }
  ? Bound<S extends (...args: any[]) => infer R ? R : S>
  : // Detect a unit by its `.node` marker before the generic object branch.
    T extends { readonly node: unknown }
    ? UnitRef<T>
    : T extends readonly unknown[]
      ? { readonly [Key in keyof T]: Bound<T[Key]> }
      : T extends (...args: any[]) => any
        ? T
        : T extends object
          ? { readonly [Key in keyof T as Key extends "@@shape" ? never : Key]: Bound<T[Key]> }
          : // A non-unit leaf is not bindable — shapes carry units only.
            never;

// Distributive over `V` so an OPTIONAL unit field (`count?: Store<number>`)
// resolves per-member to `number | undefined` (matching the runtime) rather than
// leaving the raw store — the mapped-type indexed access is not distributive.
type ResolveVueField<V> = V extends ComponentModel<infer ChildModel>
  ? ComponentModel<ChildModel>
  : // A field declaring `@@shape` binds through that declaration, to any depth.
    V extends { readonly ["@@shape"]: unknown }
    ? Bound<V>
    : // Detect a unit by its `.node` marker rather than `UnitLike`: `UnitLike`
      // collapses to `any` (because `ReactiveWritable<any>` = `any & …` = `any`),
      // which would match every non-unit field and unwrap it to `never`.
      V extends { readonly node: unknown }
      ? UnitRef<V>
      : // Arrays are kept RAW to match the runtime (buildReactiveModel does not
        // recurse into arrays), so their elements are not unwrapped.
        V extends readonly unknown[]
        ? V
        : V extends (...args: any[]) => any
          ? V
          : V extends object
            ? ReactiveModel<V>
            : V;

export type ReactiveModel<Model> = {
  readonly [Key in keyof Model as Key extends "dispose" | "@@shape"
    ? never
    : Key]: ResolveVueField<Model[Key]>;
};

export interface ModelContext<Props, Key = undefined> {
  readonly scope: Scope;
  readonly owner: Owner;
  readonly props: ReactiveWritable<Props>;
  readonly mounted: EventCallable<void>;
  readonly unmounted: EventCallable<void>;
  readonly mounts: StoreWritable<number>;
  readonly key: Key;
}

export type ModelFactory<Props, Model extends object, Key = undefined> = (
  context: ModelContext<Props, Key>,
) => Model;

export interface ModelInstance<Props, Model extends object, Key = undefined> extends ModelContext<
  Props,
  Key
> {
  readonly model: Model;
  dispose(): void;
}

export interface ModelCache<Key, Props, Model extends object> {
  has(key: Key, scope?: Scope): boolean;
  get(key: Key, scope?: Scope): Model | undefined;
  getInstance(key: Key, scope?: Scope): ModelInstance<Props, Model, Key> | undefined;
  delete(key: Key, scope?: Scope): boolean;
  clear(scope?: Scope): void;
}

export type UnitShape<Shape> = Bound<Shape>;

export type CacheOptions<Props, Key, Model extends object> = {
  readonly cache: ModelCache<Key, Props, Model>;
  readonly key: Key;
};

export type ComponentModel<Model extends object> = Model &
  DisposableOwner & {
    readonly [componentModelBrand]: true;
  };

export type ComponentPublicProps<Props, Model extends object> = Omit<Props, "model"> & {
  readonly model?: ComponentModel<Model>;
};

// `.create()` takes the model's props directly — it runs while a parent model
// is built, outside any component setup, so there is no `mapProps` step there.
export interface ComponentCreate<ModelProps, Model extends object> {
  (props: ModelProps): ComponentModel<Model>;
}

export type VirentiaComponent<Props, Model extends object, ModelProps = Props> = Component<
  ComponentPublicProps<Props, Model>
> & {
  readonly create: ComponentCreate<ModelProps, Model>;
};

export type ComponentView<Props, Model extends object> = Component<
  Props & { model: ReactiveModel<Model> }
>;

// `mapProps` bridges the component's external props to the model's props. Omit
// it and the two coincide. Provide it to derive the model props from the
// external ones, or to shape them differently. It runs in `setup`, once for the
// initial props and again when the external props change.
export type ComponentConfig<Props, Model extends object> = {
  readonly model: ModelFactory<Props, Model>;
  readonly view: ComponentView<Props, Model>;
  readonly mapProps?: (props: Props) => Props;
};

export type MappedComponentConfig<Props, ModelProps, Model extends object> = {
  readonly model: ModelFactory<ModelProps, Model>;
  readonly view: ComponentView<Props, Model>;
  readonly mapProps: (props: Props) => ModelProps;
};

export type CachedComponentConfig<Props, Key, Model extends object> = {
  readonly key: (props: Props) => Key;
  readonly cache: ModelCache<Key, Props, Model>;
  readonly model: ModelFactory<Props, Model, Key>;
  readonly view: ComponentView<Props, Model>;
  readonly mapProps?: (props: Props) => Props;
};

export type MappedCachedComponentConfig<Props, ModelProps, Key, Model extends object> = {
  readonly key: (props: ModelProps) => Key;
  readonly cache: ModelCache<Key, ModelProps, Model>;
  readonly model: ModelFactory<ModelProps, Model, Key>;
  readonly view: ComponentView<Props, Model>;
  readonly mapProps: (props: Props) => ModelProps;
};
