import {
  event,
  owner,
  reactive,
  store,
  scoped,
  type DisposableOwner,
  type ReactiveWritable,
  type Scope,
} from "@virentia/core";
import { useEffect, useMemo } from "react";
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
import { useUnitWithScope } from "./use-unit";
import { isPlainObject, isUnitLike, useIsomorphicLayoutEffect, writeStore } from "./utils";

export function useModel<Model extends object>(model: Model): ReactiveModel<Model>;
export function useModel<Props, Model extends object>(
  factory: ModelFactory<Props, Model>,
  props: Props,
): ReactiveModel<Model>;
export function useModel<Props, Key, Model extends object>(
  factory: ModelFactory<Props, Model, Key>,
  props: Props,
  options: CacheOptions<Props, Key, Model>,
): ReactiveModel<Model>;
export function useModel(
  modelOrFactory: Record<PropertyKey, unknown> | ModelFactory<any, object, any>,
  props?: unknown,
  options?: CacheOptions<any, any, object>,
): unknown {
  const scope = useProvidedScope();

  if (typeof modelOrFactory !== "function") {
    return useReactiveModel(modelOrFactory, scope);
  }

  const instance = useModelInstance(modelOrFactory, props, scope, options);

  return useReactiveModel(instance.model, instance.scope);
}

export function useModelInstance<Props, Key, Model extends object>(
  factory: ModelFactory<Props, Model, Key>,
  props: Props,
  scope: Scope,
  options?: CacheOptions<Props, Key, Model>,
): ModelInstance<Props, Model, Key> {
  const cache = options?.cache;
  const key = options?.key;
  const cached = Boolean(cache);
  const instance = useMemo(() => {
    if (cache) {
      return getOrCreateCachedInstance(cache, scope, key as Key, () =>
        createModelInstance(factory, props, scope, key as Key),
      );
    }

    return createModelInstance(factory, props, scope, undefined as Key);
  }, [cache, key, scope]);
  const disposeOnUnmount = !cached;

  useModelInstanceLifecycle(instance, props, { disposeOnUnmount });

  return instance;
}

export function useModelInstanceLifecycle<Props, Key, Model extends object>(
  instance: ModelInstance<Props, Model, Key>,
  props: Props,
  options: { disposeOnUnmount: boolean },
): void {
  const scope = instance.scope;

  useIsomorphicLayoutEffect(() => {
    writeStore(instance.props, props, scope);
  }, [instance, props, scope]);

  useEffect(() => {
    scoped(scope, () => {
      instance.mounts.value += 1;
      void instance.mounted();
    });

    return () => {
      scoped(scope, () => {
        instance.mounts.value = Math.max(0, instance.mounts.value - 1);
        void instance.unmounted();
      });

      if (options.disposeOnUnmount) {
        instance.dispose();
      }
    };
  }, [instance, options.disposeOnUnmount, scope]);
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

export function useReactiveModel<Model extends object>(
  model: Model,
  scope: Scope,
): ReactiveModel<Model> {
  const result: Record<PropertyKey, unknown> = {};

  for (const key of Reflect.ownKeys(model)) {
    const descriptor = Reflect.getOwnPropertyDescriptor(model, key);

    if (key === "dispose" || key === disposeSymbol || (descriptor && !descriptor.enumerable)) {
      continue;
    }

    result[key] = useModelValue(Reflect.get(model, key), scope);
  }

  return result as ReactiveModel<Model>;
}

const disposeSymbol =
  typeof Symbol.dispose === "symbol" ? Symbol.dispose : Symbol.for("Symbol.dispose");

const modelInstanceSymbol = Symbol("virentia.react.modelInstance");

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

function useModelValue(value: unknown, scope: Scope): unknown {
  if (isUnitLike(value)) {
    return useUnitWithScope(value, scope);
  }

  if (isComponentModel(value)) {
    return value;
  }

  if (isPlainObject(value)) {
    return useReactiveModel(value, scope);
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
