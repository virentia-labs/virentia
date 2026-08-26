import { getCurrentScope } from "@virentia/core";
import { createElement, useMemo, type ComponentType } from "react";
import type {
  CachedComponentConfig,
  ComponentConfig,
  ComponentPublicProps,
  MappedCachedComponentConfig,
  MappedComponentConfig,
  VirentiaComponent,
} from "./types";
import { getOrCreateCachedInstance } from "./model-cache";
import {
  isModelDefinition,
  isModelInstance,
  modelCollectionFor,
  useModelScreen,
  type ModelDefinitionInstance,
  type ModelDefinitionLike,
  type ModelDefinitionProps,
} from "./models";
import { useOptionalProvidedScope } from "./scope";
import {
  createModelInstance,
  exposeModelInstance,
  readExposedModelInstance,
  useModelInstanceLifecycle,
  useReactiveModel,
} from "./use-model";
import { getComponentName } from "./utils";

/** §10.1: `component({ model: OrderScreen, view, keep })` — the model is a
 * definition from @virentia/core/models, instances live in its collection. */
export interface DefinitionComponentConfig<M extends ModelDefinitionLike> {
  model: M;
  view: ComponentType<{ model: ModelDefinitionInstance<M> } & Record<string, unknown>>;
  keep?: boolean;
  mapProps?: (props: Record<string, unknown>) => ModelDefinitionProps<M>;
}

// Mapped overloads first: they require `mapProps`, so a config that provides it
// binds here (pinning external `Props` from `mapProps`' parameter), and a config
// without `mapProps` falls through to the plain overloads below.
export function component<M extends ModelDefinitionLike>(
  config: DefinitionComponentConfig<M>,
): VirentiaComponent<Record<string, unknown>, ModelDefinitionInstance<M>>;
export function component<Props, ModelProps, Key, Model extends object>(
  config: MappedCachedComponentConfig<Props, ModelProps, Key, Model>,
): VirentiaComponent<Props, Model, ModelProps>;
export function component<Props, ModelProps, Model extends object>(
  config: MappedComponentConfig<Props, ModelProps, Model>,
): VirentiaComponent<Props, Model, ModelProps>;
export function component<Props, Key, Model extends object>(
  config: CachedComponentConfig<Props, Key, Model>,
): VirentiaComponent<Props, Model, Props>;
export function component<Props, Model extends object>(
  config: ComponentConfig<Props, Model>,
): VirentiaComponent<Props, Model, Props>;
export function component(
  config:
    | ComponentConfig<any, any>
    | MappedComponentConfig<any, any, any>
    | CachedComponentConfig<any, any, any>
    | MappedCachedComponentConfig<any, any, any, any>,
): VirentiaComponent<any, any> {
  const VirentiaComponent = (props: ComponentPublicProps<any, any>) => {
    // §10.1: a definition-model component — one uniform hook path handles both
    // the owned instance and a controlled one from `component.create()`.
    if (isModelDefinition((config as { model?: unknown }).model)) {
      const { model: controlledModel, ...externalProps } = props;
      const modelProps = config.mapProps
        ? (config.mapProps(externalProps) as Record<string, unknown>)
        : externalProps;
      const controlled =
        controlledModel && isModelInstance(controlledModel) ? (controlledModel as object) : null;

      if (controlledModel && !controlled) {
        throw new Error("[component] The model prop must be created with component.create().");
      }

      const facade = useModelScreen(
        (config as { model: object }).model,
        modelProps,
        { keep: (config as { keep?: boolean }).keep },
        controlled,
      );

      return createElement(config.view, { ...externalProps, model: facade });
    }

    const { model: controlledModel, ...externalProps } = props;
    const providedScope = useOptionalProvidedScope();
    const controlledInstance = controlledModel
      ? readExposedModelInstance(controlledModel)
      : null;
    // Mapped during render, so `mapProps` may read context or call hooks. Called
    // unconditionally when present, keeping hook order stable across renders.
    const modelProps = config.mapProps ? config.mapProps(externalProps) : externalProps;
    const key = "cache" in config ? config.key(modelProps) : undefined;
    const instance = useMemo(() => {
      if (controlledModel) {
        if (!controlledInstance) {
          throw new Error("[component] The model prop must be created with component.create().");
        }

        return controlledInstance;
      }

      if (!providedScope) {
        throw new Error(
          "[useProvidedScope] Scope is not provided. Wrap your tree with ScopeProvider.",
        );
      }

      if ("cache" in config) {
        return getOrCreateCachedInstance(config.cache, providedScope, key, () =>
          createModelInstance(config.model, modelProps, providedScope, key),
        );
      }

      return createModelInstance(config.model, modelProps, providedScope, undefined);
    }, [controlledInstance, controlledModel, key, providedScope]);
    const cached = !controlledModel && "cache" in config;
    const model = useReactiveModel(instance.model, instance.scope);

    useModelInstanceLifecycle(instance, modelProps, {
      disposeOnUnmount: !controlledModel && !cached,
    });

    return createElement(config.view, { ...externalProps, model });
  };

  VirentiaComponent.displayName = getComponentName(config.view);
  VirentiaComponent.create = ((props: Record<PropertyKey, unknown>) => {
    const externalScope = getCurrentScope();

    if (!externalScope) {
      throw new Error(
        "[component.create] Parent component context is required. Call .create() while creating a parent component model.",
      );
    }

    // §10.1: a definition's controlled instance is a plain collection add —
    // the collection is its home, the creator owns its end of life.
    if (isModelDefinition((config as { model?: unknown }).model)) {
      return modelCollectionFor((config as { model: object }).model, externalScope).add(props ?? {});
    }

    const key = "cache" in config ? config.key(props) : undefined;
    const instance = createModelInstance(config.model, props, externalScope, key);

    return exposeModelInstance(instance);
  }) as VirentiaComponent<any, any>["create"];

  return VirentiaComponent as VirentiaComponent<any, any>;
}
