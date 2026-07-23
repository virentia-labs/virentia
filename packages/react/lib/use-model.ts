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
import {
  bindCallable,
  defineStoreLeaf,
  defineValue,
  guardCycle,
  isComponentModel,
  modelInstanceSymbol,
  resolveUnitNode,
  useTrackedTree,
  type TrackContext,
} from "./tracked";
import {
  getShape,
  isPlainObject,
  isStoreUnit,
  isUnitLike,
  SHAPE,
  useIsomorphicLayoutEffect,
  writeStore,
} from "./utils";

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
  return useTrackedTree(model, scope, walkModel) as ReactiveModel<Model>;
}

// Builds a model's tracked tree. A model differs from a bare `useUnit` shape:
// keys `dispose`/`@@shape`/non-enumerable are dropped, arrays and class
// instances stay raw, a nested `ComponentModel` passes through untouched, a
// field declaring `@@shape` binds through it, and a plain object recurses with
// these same model rules.
const walkModel = (model: unknown, ctx: TrackContext): unknown =>
  resolveModelObject(model as object, ctx, new WeakSet<object>());

function resolveModelObject(model: object, ctx: TrackContext, seen: WeakSet<object>): object {
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

    defineModelChild(result, key, Reflect.get(model, key), ctx, seen);
  }

  return result;
}

function defineModelChild(
  target: object,
  key: PropertyKey,
  raw: unknown,
  ctx: TrackContext,
  seen: WeakSet<object>,
): void {
  if (isUnitLike(raw)) {
    if (isStoreUnit(raw)) {
      defineStoreLeaf(target, key, raw, ctx);
    } else {
      defineValue(target, key, bindCallable(raw, ctx.scope));
    }
    return;
  }

  if (isComponentModel(raw)) {
    defineValue(target, key, raw);
    return;
  }

  // A field that declares `@@shape` binds through that declaration, so an opaque
  // value (a class-based sub-model) still reaches the view as bound units.
  const shape = getShape(raw);

  if (shape !== undefined) {
    defineValue(
      target,
      key,
      guardCycle(raw as object, seen, () => resolveUnitNode(shape, ctx, seen)),
    );
    return;
  }

  if (isPlainObject(raw)) {
    defineValue(
      target,
      key,
      guardCycle(raw, seen, () => resolveModelObject(raw, ctx, seen)),
    );
    return;
  }

  // Arrays, class instances, plain methods, and primitives stay raw.
  defineValue(target, key, raw);
}

const disposeSymbol =
  typeof Symbol.dispose === "symbol" ? Symbol.dispose : Symbol.for("Symbol.dispose");

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
