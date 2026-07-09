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

// Distributive over `V` (a naked type parameter), so an OPTIONAL unit field
// (`count?: Store<number>` → `Store<number> | undefined`) resolves per-member to
// `number | undefined` instead of leaving the raw store (the mapped-type indexed
// access is not distributive on its own).
type ResolveReactiveField<V> = V extends ComponentModel<infer ChildModel>
  ? ComponentModel<ChildModel>
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
  readonly [Key in keyof Model as Key extends "dispose" ? never : Key]: ResolveReactiveField<
    Model[Key]
  >;
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

export type UnitShape<Shape> = Shape extends readonly unknown[]
  ? { readonly [Key in keyof Shape]: UnitValue<Shape[Key]> }
  : Shape extends Record<string, unknown>
    ? { readonly [Key in keyof Shape]: UnitValue<Shape[Key]> }
    : never;

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

export interface ComponentCreate<Props, Model extends object> {
  (props: Props): ComponentModel<Model>;
}

export type VirentiaComponent<Props, Model extends object> = FC<
  ComponentPublicProps<Props, Model>
> & {
  readonly create: ComponentCreate<Props, Model>;
};

export type ComponentConfig<Props, Model extends object> = {
  readonly model: ModelFactory<Props, Model>;
  readonly view: ComponentType<Props & { model: ReactiveModel<Model> }>;
};

export type CachedComponentConfig<Props, Key, Model extends object> = {
  readonly key: (props: Props) => Key;
  readonly cache: ModelCache<Key, Props, Model>;
  readonly model: ModelFactory<Props, Model, Key>;
  readonly view: ComponentType<Props & { model: ReactiveModel<Model> }>;
};
