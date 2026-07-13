import {
  event,
  owner,
  reactive,
  scoped,
  store,
  type DisposableOwner,
  type ReactiveWritable,
  type Scope,
} from "@virentia/core";
import { onMounted, onUnmounted, toValue, watch, type MaybeRefOrGetter } from "vue";
import { getOrCreateCachedInstance } from "./model-cache";
import { useProvidedScope } from "./scope";
import type {
  CacheOptions,
  ComponentModel,
  ModelContext,
  ModelFactory,
  ModelInstance,
  ReactiveModel,
} from "./types";
import { bindUnit, bindUnits } from "./use-unit";
import { getShape, isPlainObject, isUnitLike, SHAPE, writeStore } from "./utils";

export function useModel<Model extends object>(model: Model): ReactiveModel<Model>;
export function useModel<Props, Model extends object>(
  factory: ModelFactory<Props, Model>,
  props: MaybeRefOrGetter<Props>,
): ReactiveModel<Model>;
export function useModel<Props, Key, Model extends object>(
  factory: ModelFactory<Props, Model, Key>,
  props: MaybeRefOrGetter<Props>,
  options: CacheOptions<Props, Key, Model>,
): ReactiveModel<Model>;
export function useModel(
  modelOrFactory: Record<PropertyKey, unknown> | ModelFactory<any, object, any>,
  props?: MaybeRefOrGetter<unknown>,
  options?: CacheOptions<any, any, object>,
): unknown {
  const scope = useProvidedScope();

  if (typeof modelOrFactory !== "function") {
    return buildReactiveModel(modelOrFactory, scope);
  }

  const instance = useModelInstance(modelOrFactory, props, scope, options);

  return buildReactiveModel(instance.model, instance.scope);
}

export function useModelInstance<Props, Key, Model extends object>(
  factory: ModelFactory<Props, Model, Key>,
  props: MaybeRefOrGetter<Props>,
  scope: Scope,
  options?: CacheOptions<Props, Key, Model>,
): ModelInstance<Props, Model, Key> {
  const cache = options?.cache;
  const key = options?.key;
  const cached = Boolean(cache);
  const instance = cache
    ? getOrCreateCachedInstance(cache, scope, key as Key, () =>
        createModelInstance(factory, toValue(props), scope, key as Key),
      )
    : createModelInstance(factory, toValue(props), scope, undefined as Key);

  useModelInstanceLifecycle(instance, props, { disposeOnUnmount: !cached });

  return instance;
}

export function useModelInstanceLifecycle<Props, Key, Model extends object>(
  instance: ModelInstance<Props, Model, Key>,
  props: MaybeRefOrGetter<Props>,
  options: { disposeOnUnmount: boolean },
): void {
  const scope = instance.scope;

  writeStore(instance.props, toValue(props), scope);

  watch(
    () => toValue(props),
    (next) => {
      writeStore(instance.props, next, scope);
    },
    { deep: true },
  );

  onMounted(() => {
    scoped(scope, () => {
      instance.mounts.value += 1;
      void instance.mounted();
    });
  });

  onUnmounted(() => {
    scoped(scope, () => {
      instance.mounts.value = Math.max(0, instance.mounts.value - 1);
      void instance.unmounted();
    });

    if (options.disposeOnUnmount) {
      instance.dispose();
    }
  });
}

export function createModelInstance<Props, Key, Model extends object>(
  factory: ModelFactory<Props, Model, Key>,
  props: Props,
  scope: Scope,
  key: Key,
): ModelInstance<Props, Model, Key> {
  return owner((dispose, modelOwner) => {
    // Props are always an object, so the store exposes fields directly (`props.foo`).
    const propsStore = reactive(props as object) as unknown as ReactiveWritable<Props>;
    const mounted = event<void>();
    const unmounted = event<void>();
    const mounts = store(0);
    const context = {
      scope,
      owner: modelOwner,
      props: propsStore,
      mounted,
      unmounted,
      mounts,
      key,
    } satisfies ModelContext<Props, Key>;
    const model = scoped(scope, () => factory(context));

    return {
      ...context,
      model,
      dispose,
    };
  });
}

export function exposeModelInstance<Props, Key, Model extends object>(
  instance: ModelInstance<Props, Model, Key>,
): ComponentModel<Model> {
  const model = instance.model as ComponentModel<Model> & ModelWithInstance<Props, Model, Key>;

  Object.defineProperty(model, modelInstanceSymbol, {
    configurable: true,
    value: instance,
  });
  defineHidden(model, "dispose", () => instance.dispose());
  defineHidden(model, disposeSymbol, () => instance.dispose());

  return model;
}

export function readExposedModelInstance<Props, Key, Model extends object>(
  model: ComponentModel<Model>,
): ModelInstance<Props, Model, Key> | null {
  return (model as ModelWithInstance<Props, Model, Key>)[modelInstanceSymbol] ?? null;
}

export function buildReactiveModel<Model extends object>(
  model: Model,
  scope: Scope,
): ReactiveModel<Model> {
  const result: Record<PropertyKey, unknown> = {};

  for (const key of Reflect.ownKeys(model)) {
    const descriptor = Reflect.getOwnPropertyDescriptor(model, key);

    if (
      key === "dispose" ||
      key === disposeSymbol ||
      key === SHAPE ||
      (descriptor && !descriptor.enumerable)
    ) {
      continue;
    }

    result[key] = buildModelValue(Reflect.get(model, key), scope);
  }

  return result as ReactiveModel<Model>;
}

const disposeSymbol =
  typeof Symbol.dispose === "symbol" ? Symbol.dispose : Symbol.for("Symbol.dispose");

const modelInstanceSymbol = Symbol("virentia.vue.modelInstance");

type ModelWithInstance<Props, Model extends object, Key> = {
  [modelInstanceSymbol]?: ModelInstance<Props, Model, Key>;
};

function defineHidden(target: DisposableOwner, key: PropertyKey, value: unknown): void {
  if (key in target) {
    return;
  }

  Object.defineProperty(target, key, {
    configurable: true,
    value,
  });
}

function buildModelValue(value: unknown, scope: Scope): unknown {
  if (isUnitLike(value)) {
    return bindUnit(value, scope);
  }

  if (isComponentModel(value)) {
    return value;
  }

  // A field that declares `@@shape` binds through that declaration, so an opaque
  // value (a class-based sub-model) still reaches the view as bound units.
  if (getShape(value) !== undefined) {
    return bindUnits(value, scope);
  }

  if (isPlainObject(value)) {
    return buildReactiveModel(value, scope);
  }

  return value;
}

function isComponentModel(value: unknown): value is ComponentModel<object> {
  return Boolean(
    value &&
    typeof value === "object" &&
    (value as ModelWithInstance<unknown, object, unknown>)[modelInstanceSymbol],
  );
}
