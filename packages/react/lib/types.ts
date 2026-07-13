import type {
  Effect,
  EffectCallArgs,
  EventCallable,
  EventPayload,
  DisposableOwner,
  Owner,
  Reactive,
  ReactiveWritable,
  Scope,
  Store,
  StoreWritable,
} from "@virentia/core";
import type { ComponentType, FC } from "react";

export type AnyStore<State = any> =
  | Store<State>
  | StoreWritable<State>
  | Reactive<State>
  | ReactiveWritable<State>;

export type UnitLike = AnyStore | EventCallable<any> | Effect<any, any, any>;

declare const componentModelBrand: unique symbol;

export type UnitValue<Unit> =
  Unit extends AnyStore<infer State>
    ? State
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

/** Resolves a shape to what `useUnit` yields: units become their bound value,
 * `@@shape` declarations are unwrapped, and arrays/records are mapped
 * recursively so nesting resolves to any depth. */
export type Bound<T> = T extends { readonly ["@@shape"]: infer S }
  ? Bound<S extends (...args: any[]) => infer R ? R : S>
  : // Detect a unit by its `.node` marker before the generic object branch.
    T extends { readonly node: unknown }
    ? UnitValue<T>
    : T extends readonly unknown[]
      ? { readonly [Key in keyof T]: Bound<T[Key]> }
      : T extends (...args: any[]) => any
        ? T
        : T extends object
          ? { readonly [Key in keyof T as Key extends "@@shape" ? never : Key]: Bound<T[Key]> }
          : // A non-unit leaf is not bindable — shapes carry units only.
            never;

// Distributive over `V` (a naked type parameter), so an OPTIONAL unit field
// (`count?: Store<number>` → `Store<number> | undefined`) resolves per-member to
// `number | undefined` instead of leaving the raw store (the mapped-type indexed
// access is not distributive on its own).
type ResolveReactiveField<V> = V extends ComponentModel<infer ChildModel>
  ? ComponentModel<ChildModel>
  : // A field declaring `@@shape` binds through that declaration, to any depth.
    V extends { readonly ["@@shape"]: unknown }
    ? Bound<V>
    : // Detect a unit by its `.node` marker rather than `UnitLike`: `UnitLike`
      // collapses to `any` (because `ReactiveWritable<any>` = `any & …` = `any`),
      // which would match every non-unit field and unwrap it to `never`.
      V extends { readonly node: unknown }
      ? UnitValue<V>
      : // Arrays are kept RAW to match the runtime (useReactiveModel does not
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
    : Key]: ResolveReactiveField<Model[Key]>;
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
// is built, outside any React render, so there is no `mapProps` step there.
export interface ComponentCreate<ModelProps, Model extends object> {
  (props: ModelProps): ComponentModel<Model>;
}

export type VirentiaComponent<Props, Model extends object, ModelProps = Props> = FC<
  ComponentPublicProps<Props, Model>
> & {
  readonly create: ComponentCreate<ModelProps, Model>;
};

// `mapProps` bridges the component's external props to the model's props. Omit
// it and the two coincide. Provide it to derive the model props from the
// external ones — the mapping runs during render, so it may read React context
// or call hooks (e.g. a router's `useParams`) — or to shape them differently.
export type ComponentConfig<Props, Model extends object> = {
  readonly model: ModelFactory<Props, Model>;
  readonly view: ComponentType<Props & { model: ReactiveModel<Model> }>;
  readonly mapProps?: (props: Props) => Props;
};

export type MappedComponentConfig<Props, ModelProps, Model extends object> = {
  readonly model: ModelFactory<ModelProps, Model>;
  readonly view: ComponentType<Props & { model: ReactiveModel<Model> }>;
  readonly mapProps: (props: Props) => ModelProps;
};

export type CachedComponentConfig<Props, Key, Model extends object> = {
  readonly key: (props: Props) => Key;
  readonly cache: ModelCache<Key, Props, Model>;
  readonly model: ModelFactory<Props, Model, Key>;
  readonly view: ComponentType<Props & { model: ReactiveModel<Model> }>;
  readonly mapProps?: (props: Props) => Props;
};

export type MappedCachedComponentConfig<Props, ModelProps, Key, Model extends object> = {
  readonly key: (props: ModelProps) => Key;
  readonly cache: ModelCache<Key, ModelProps, Model>;
  readonly model: ModelFactory<ModelProps, Model, Key>;
  readonly view: ComponentType<Props & { model: ReactiveModel<Model> }>;
  readonly mapProps: (props: Props) => ModelProps;
};
