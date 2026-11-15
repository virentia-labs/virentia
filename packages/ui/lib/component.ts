import {
  type AnyModel,
  type Dto,
  type InstanceOf,
  type ModelDefinition,
} from "@virentia/core/models";
import type { Child, Component, ComponentSelf, Readable } from "./types";
import { isModelDefinition, modelDefinitionBindingOf, type ModelDefinitionBinding } from "@virentia/core/internal";

/** Constructor inputs and view props share one model-derived contract. */
type ModelInputs<M extends AnyModel> = Dto<M> &
  (M extends { readonly "~props"?: infer P } ? NonNullable<P> : {});
export type ModelProps<M extends AnyModel> = {
  [K in keyof ModelInputs<M>]: K extends "id"
    ? ModelInputs<M>[K]
    : ModelInputs<M>[K] | Readable<ModelInputs<M>[K]>;
};

export type ComponentInput<M extends AnyModel> =
  | (ModelProps<M> & { model?: undefined; keep?: boolean })
  | (Partial<ModelProps<M>> & {
      model: InstanceOf<M> | Readable<InstanceOf<M> | null>;
      keep?: boolean;
    });

export interface ComponentOptions<P extends object = Record<string, unknown>> {
  /** Keep an automatically created model after its display unmounts. */
  keep?: boolean;
  /** Optional local identity derived from constructor props. */
  id?: (props: P) => string;
  /** Stable root used by host-renderer adapters. */
  root?: string;
}

export interface ComponentConfig<M extends AnyModel> extends ComponentOptions<ModelProps<M>> {
  model: M;
  /** Called once per DOM attachment, never by scalar state updates. */
  view: (props: ModelProps<M>, self: ComponentSelf<M>) => Child;
}

export type DefinedComponent<M extends AnyModel> = Component<ComponentInput<M>> & {
  readonly model: M;
};

export interface ComponentMetadata<M extends AnyModel = AnyModel> {
  readonly model: M;
  readonly view: ComponentConfig<M>["view"];
  readonly keep: boolean;
  readonly id?: ComponentConfig<M>["id"];
  readonly lifecycle?: { mounted: boolean; unmounted: boolean };
  readonly definitionBinding?: ModelDefinitionBinding;
  readonly idFromProps?: ModelDefinition["idFromProps"];
}

const metadata = new WeakMap<Function, ComponentMetadata>();
const rootTags = new WeakMap<Function, string>();

export function withRoot<T extends Component<any>>(view: T, tag: string): T {
  rootTags.set(view, tag);
  return view;
}

export function componentRootOf(type: Component<any>): string | undefined {
  return rootTags.get(type);
}

/** Bind an existing Core model definition to a DOM view; no hidden model. */
export function component<M extends AnyModel>(config: ComponentConfig<M>): DefinedComponent<M> {
  if (!config || !isModelDefinition(config.model) || typeof config.view !== "function") {
    throw new TypeError("[ui] component expects { model: model/staticModel, view }");
  }
  const result = ((props: ComponentInput<M>, self: ComponentSelf<M>) =>
    config.view(props as ModelProps<M>, self)) as DefinedComponent<M>;
  Object.defineProperty(result, "model", { value: config.model, enumerable: true });
  const definition = config.model as unknown as ModelDefinition;
  const hasMember = (name: string) =>
    definition.staticMembers?.has(name) ||
    definition.fields.has(name) ||
    definition.relations.has(name) ||
    definition.inverses.has(name);
  metadata.set(result, {
    model: config.model,
    view: config.view,
    keep: config.keep === true,
    id: config.id,
    definitionBinding: modelDefinitionBindingOf(config.model),
    idFromProps: definition.idFromProps,
    lifecycle:
      definition.kind === "static"
        ? { mounted: Boolean(hasMember("mounted")), unmounted: Boolean(hasMember("unmounted")) }
        : undefined,
  } as unknown as ComponentMetadata);
  if (config.root) withRoot(result, config.root);
  return result;
}

/** @internal Plain view helpers do not acquire a model or identity. */
export function componentMetadataOf(type: Component<any>): ComponentMetadata | undefined {
  return metadata.get(type);
}
