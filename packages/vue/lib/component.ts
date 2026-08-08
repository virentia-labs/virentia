import { getCurrentScope } from "@virentia/core";
import { collection, isModelDefinition, isModelInstance } from "@virentia/core/models";
import type { AnyModel, Dto, InstanceOf } from "@virentia/core/models";
import { defineComponent, h, type Component } from "vue";
import { getOrCreateCachedInstance } from "./model-cache";
import { useModelScreen } from "./models";
import { useOptionalProvidedScope } from "./scope";
import type {
  CachedComponentConfig,
  ComponentConfig,
  ComponentModel,
  MappedCachedComponentConfig,
  MappedComponentConfig,
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

/** §10.2: `component({ model: OrderScreen, view, keep })` — the model is a
 * definition from @virentia/core/models, instances live in its collection. */
export interface DefinitionComponentConfig<M extends AnyModel> {
  model: M;
  view: Component;
  keep?: boolean;
  mapProps?: (props: Record<string, unknown>) => Partial<Dto<M>> & { id?: string };
}

// Mapped overloads first: they require `mapProps`, so a config that provides it
// binds here (pinning external `Props` from `mapProps`' parameter, which Vue's
// loose `Component` view type cannot), and a config without `mapProps` falls
// through to the plain overloads below.
export function component<M extends AnyModel>(
  config: DefinitionComponentConfig<M>,
): VirentiaComponent<Record<string, unknown>, InstanceOf<M>>;
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
  const wrapper = defineComponent({
    name: getComponentName(config.view),
    inheritAttrs: false,
    setup(_props, { attrs, slots }) {
      // §10.2: a definition-model component — the collection is the instance's
      // home, `keep`/controlled decide the end of life (§10.1).
      if (isModelDefinition((config as { model?: unknown }).model)) {
        const readExternal = (): Record<string, unknown> => {
          const { model: _model, ...rest } = attrs as Record<string, unknown>;

          return rest;
        };
        const readModelProps = (): Record<string, unknown> =>
          config.mapProps
            ? (config.mapProps(readExternal() as never) as Record<string, unknown>)
            : readExternal();
        const controlledAttr = attrs.model as object | undefined;
        const controlled =
          controlledAttr && isModelInstance(controlledAttr) ? controlledAttr : null;

        if (controlledAttr && !controlled) {
          throw new Error("[component] The model prop must be created with component.create().");
        }

        const facade = useModelScreen(
          (config as { model: object }).model,
          readModelProps,
          { keep: (config as { keep?: boolean }).keep },
          controlled,
        );

        return () => h(config.view, { ...readExternal(), model: facade.value }, slots);
      }

      const providedScope = useOptionalProvidedScope();
      const controlledModel = attrs.model as ComponentModel<any> | undefined;
      const controlledInstance = controlledModel ? readExposedModelInstance(controlledModel) : null;
      const readExternalProps = (): Record<string, unknown> => {
        const { model: _model, ...rest } = attrs as Record<string, unknown>;

        return rest;
      };
      // `mapProps` derives the model props from the external ones; without it
      // the two coincide. Re-evaluated by the lifecycle watcher on prop changes.
      const readModelProps = (): unknown =>
        config.mapProps ? config.mapProps(readExternalProps()) : readExternalProps();
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

      return () => h(config.view, { ...readExternalProps(), model: reactiveModel }, slots);
    },
  });

  (wrapper as { create?: unknown }).create = (props: Record<PropertyKey, unknown>) => {
    const externalScope = getCurrentScope();

    if (!externalScope) {
      throw new Error(
        "[component.create] Parent component context is required. Call .create() while creating a parent component model.",
      );
    }

    // §10.2: a definition's controlled instance is a plain collection add.
    if (isModelDefinition((config as { model?: unknown }).model)) {
      return (
        collection(
          (config as unknown as { model: never }).model,
          externalScope,
        ) as unknown as { add(input: Record<PropertyKey, unknown>): object }
      ).add(props ?? {});
    }

    const key = "cache" in config ? config.key(props) : undefined;
    const instance = createModelInstance(config.model, props, externalScope, key);

    return exposeModelInstance(instance);
  };

  return wrapper as unknown as VirentiaComponent<any, any>;
}
