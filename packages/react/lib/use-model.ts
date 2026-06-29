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
import { useEffect, useMemo, useRef } from "react";
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

  // Tracks live mounts per instance. React StrictMode (and fast remounts) run
  // unmount immediately followed by remount with no render in between, so the
  // `useMemo`-cached instance is reused. Disposing synchronously on the fake
  // unmount would tear down the model's reactions irreversibly and the reused
  // instance would be dead. We defer disposal to a microtask and skip it if the
  // instance got remounted (mount count back above zero).
  const mountCountsRef = useRef<WeakMap<object, number> | null>(null);

  if (mountCountsRef.current === null) {
    mountCountsRef.current = new WeakMap<object, number>();
  }

  const mountCounts = mountCountsRef.current;

  useIsomorphicLayoutEffect(() => {
    writeStore(instance.props, props, scope);
  }, [instance, props, scope]);

  useEffect(() => {
    mountCounts.set(instance, (mountCounts.get(instance) ?? 0) + 1);

    scoped(scope, () => {
      instance.mounts.value += 1;
      void instance.mounted();
    });

    return () => {
      mountCounts.set(instance, Math.max(0, (mountCounts.get(instance) ?? 1) - 1));

      scoped(scope, () => {
        instance.mounts.value = Math.max(0, instance.mounts.value - 1);
        void instance.unmounted();
      });

      if (options.disposeOnUnmount) {
        queueMicrotask(() => {
          if ((mountCounts.get(instance) ?? 0) === 0) {
            instance.dispose();
          }
        });
      }
    };
  }, [instance, options.disposeOnUnmount, scope, mountCounts]);
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
