import { getCurrentScope } from "@virentia/core";
import { createElement, useMemo } from "react";
import type {
  CachedComponentConfig,
  ComponentConfig,
  ComponentPublicProps,
  MappedCachedComponentConfig,
  MappedComponentConfig,
  VirentiaComponent,
} from "./types";
import { getOrCreateCachedInstance } from "./model-cache";
import { useOptionalProvidedScope } from "./scope";
import {
  createModelInstance,
  exposeModelInstance,
  readExposedModelInstance,
  useModelInstanceLifecycle,
  useReactiveModel,
} from "./use-model";
import { getComponentName } from "./utils";

// Mapped overloads first: they require `mapProps`, so a config that provides it
// binds here (pinning external `Props` from `mapProps`' parameter), and a config
// without `mapProps` falls through to the plain overloads below.
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

    const key = "cache" in config ? config.key(props) : undefined;
    const instance = createModelInstance(config.model, props, externalScope, key);

    return exposeModelInstance(instance);
  }) as VirentiaComponent<any, any>["create"];

  return VirentiaComponent as VirentiaComponent<any, any>;
}
