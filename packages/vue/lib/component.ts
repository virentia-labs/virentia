import { getCurrentScope } from "@virentia/core";
import { defineComponent, h } from "vue";
import { getOrCreateCachedInstance } from "./model-cache";
import { useOptionalProvidedScope } from "./scope";
import type {
  CachedComponentConfig,
  ComponentConfig,
  ComponentModel,
  ModelInstance,
  VirentiaComponent,
} from "./types";
import {
  buildReactiveModel,
  createModelInstance,
  exposeModelInstance,
  readExposedModelInstance,
  useModelInstanceLifecycle,
} from "./use-model";
import { getComponentName } from "./utils";

export function component<Props, Model extends object>(
  config: ComponentConfig<Props, Model>,
): VirentiaComponent<Props, Model>;
export function component<Props, Key, Model extends object>(
  config: CachedComponentConfig<Props, Key, Model>,
): VirentiaComponent<Props, Model>;
export function component(
  config: ComponentConfig<any, any> | CachedComponentConfig<any, any, any>,
): VirentiaComponent<any, any> {
  const wrapper = defineComponent({
    name: getComponentName(config.view),
    inheritAttrs: false,
    setup(_props, { attrs, slots }) {
      const providedScope = useOptionalProvidedScope();
      const controlledModel = attrs.model as ComponentModel<any> | undefined;
      const controlledInstance = controlledModel ? readExposedModelInstance(controlledModel) : null;
      const readModelProps = (): Record<string, unknown> => {
        const { model: _model, ...rest } = attrs as Record<string, unknown>;

        return rest;
      };
      const key = "cache" in config ? config.key(readModelProps()) : undefined;
      let instance: ModelInstance<any, any, any>;

      if (controlledModel) {
        if (!controlledInstance) {
          throw new Error("[component] The model prop must be created with component.create().");
        }

        instance = controlledInstance;
      } else {
        if (!providedScope) {
          throw new Error(
            "[useProvidedScope] Scope is not provided. Wrap your tree with ScopeProvider.",
          );
        }

        instance =
          "cache" in config
            ? getOrCreateCachedInstance(config.cache, providedScope, key, () =>
                createModelInstance(config.model, readModelProps(), providedScope, key),
              )
            : createModelInstance(config.model, readModelProps(), providedScope, undefined);
      }

      const cached = !controlledModel && "cache" in config;
      const reactiveModel = buildReactiveModel(instance.model, instance.scope);

      useModelInstanceLifecycle(instance, readModelProps, {
        disposeOnUnmount: !controlledModel && !cached,
      });

      return () => h(config.view, { ...readModelProps(), model: reactiveModel }, slots);
    },
  });

  (wrapper as { create?: unknown }).create = (props: Record<PropertyKey, unknown>) => {
    const externalScope = getCurrentScope();

    if (!externalScope) {
      throw new Error(
        "[component.create] Parent component context is required. Call .create() while creating a parent component model.",
      );
    }

    const key = "cache" in config ? config.key(props) : undefined;
    const instance = createModelInstance(config.model, props, externalScope, key);

    return exposeModelInstance(instance);
  };

  return wrapper as unknown as VirentiaComponent<any, any>;
}
