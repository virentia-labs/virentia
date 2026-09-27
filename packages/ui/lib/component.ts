import { event, type EventCallable } from "@virentia/core";
import { staticModel, type ModelDefinition } from "@virentia/core/models";
import type { Child, Component, ComponentLifecycle, ComponentLifecycleEvent } from "./types";

/** Configure the lifetime and identity of a function component's model instance. */
export interface ComponentOptions<P extends object> {
  /** Retain the model instance after its DOM subtree unmounts. */
  keep?: boolean;
  /** Derive the instance id from props; the runtime supplies a tree id otherwise. */
  id?: (props: P) => string;
}

/** A configured JSX component with an inspectable Core model definition. */
export type DefinedComponent<P extends object> = Component<P> & {
  readonly model: ModelDefinition;
};

/** @internal Runtime metadata for both configured and ordinary function components. */
export interface ComponentMetadata<P extends object> {
  readonly view: Component<P>;
  readonly model: ModelDefinition;
  readonly lifecycle: {
    readonly mounted: EventCallable<ComponentLifecycleEvent<P>>;
    readonly unmounted: EventCallable<ComponentLifecycleEvent<P>>;
  };
  readonly keep: boolean;
  readonly id?: (props: P) => string;
}

const metadata = new WeakMap<Component<object>, ComponentMetadata<object>>();

function defineComponent<P extends object>(
  view: Component<P>,
  options: ComponentOptions<P>,
): ComponentMetadata<P> {
  let mounted!: EventCallable<ComponentLifecycleEvent<P>>;
  let unmounted!: EventCallable<ComponentLifecycleEvent<P>>;
  const model = staticModel({
    name: view.name || undefined,
    setup: () => {
      mounted = event<ComponentLifecycleEvent<P>>(`${view.name || "component"}.mounted`);
      unmounted = event<ComponentLifecycleEvent<P>>(`${view.name || "component"}.unmounted`);
      return { view };
    },
  }) as ModelDefinition;

  return {
    view,
    model,
    lifecycle: { mounted, unmounted },
    keep: options.keep === true,
    id: options.id,
  };
}

/**
 * Add explicit model lifetime or id derivation to a function component.
 * A plain function component receives the same static-model backing lazily.
 */
export function component<P extends object>(
  view: Component<P>,
  options: ComponentOptions<P> = {},
): DefinedComponent<P> {
  const configured = function VirentiaComponent(props: P, lifecycle: ComponentLifecycle<P>): Child {
    return view(props, lifecycle);
  };
  const definition = defineComponent(view, options);
  Object.defineProperty(configured, "model", {
    value: definition.model,
    enumerable: true,
  });
  metadata.set(configured as Component<object>, definition as unknown as ComponentMetadata<object>);
  return configured as DefinedComponent<P>;
}

/** @internal Return the stable model definition associated with a JSX component type. */
export function componentMetadataOf<P extends object>(type: Component<P>): ComponentMetadata<P> {
  let known = metadata.get(type as Component<object>);
  if (!known) {
    known = defineComponent(type, {}) as unknown as ComponentMetadata<object>;
    metadata.set(type as Component<object>, known);
  }
  return known as unknown as ComponentMetadata<P>;
}
