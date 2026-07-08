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

export type ReactiveModel<Model> = {
  readonly [Key in keyof Model as Key extends "dispose"
    ? never
    : Key]: Model[Key] extends ComponentModel<infer ChildModel>
    ? ComponentModel<ChildModel>
    : // Detect a unit by its `.node` marker rather than `UnitLike`: `UnitLike`
      // collapses to `any` (because `ReactiveWritable<any>` = `any & …` = `any`),
      // which would match every non-unit field and unwrap it to `never`.
      Model[Key] extends { readonly node: unknown }
      ? UnitRef<Model[Key]>
      : Model[Key] extends (...args: any[]) => any
        ? Model[Key]
        : Model[Key] extends object
          ? ReactiveModel<Model[Key]>
          : Model[Key];
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
  ? { readonly [Key in keyof Shape]: UnitRef<Shape[Key]> }
  : Shape extends Record<string, unknown>
    ? { readonly [Key in keyof Shape]: UnitRef<Shape[Key]> }
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

export type VirentiaComponent<Props, Model extends object> = Component<
  ComponentPublicProps<Props, Model>
> & {
  readonly create: ComponentCreate<Props, Model>;
};

export type ComponentView<Props, Model extends object> = Component<
  Props & { model: ReactiveModel<Model> }
>;

export type ComponentConfig<Props, Model extends object> = {
  readonly model: ModelFactory<Props, Model>;
  readonly view: ComponentView<Props, Model>;
};

export type CachedComponentConfig<Props, Key, Model extends object> = {
  readonly key: (props: Props) => Key;
  readonly cache: ModelCache<Key, Props, Model>;
  readonly model: ModelFactory<Props, Model, Key>;
  readonly view: ComponentView<Props, Model>;
};
