// @virentia/core/models — declaration of models through traits, instance
// scope-local instance registries, field-declared indexes, descriptor queries, codec as
// props bindings.

import { modelDefinitionBinding, type ModelDefinitionBinding } from "./bindings";
import { modelCollection } from "./collection";
import { createSingleton } from "./singleton";
import {
  model as createModel,
  staticModel as createStaticModel,
  type ModelConfig,
  type ModelDefinition,
} from "./definition";

function bindDefinition(definition: ModelDefinition): ModelDefinition {
  Object.defineProperty(definition, "~static", {
    value: (input?: Record<string, unknown>) => createSingleton(definition, input, bindDefinition),
  });
  Object.defineProperty(definition, "~instancesInScope", {
    value: () => modelCollection(definition),
  });
  Object.defineProperty(definition, modelDefinitionBinding, {
    value: {
      collection: (scope) => modelCollection(definition, scope),
    } satisfies ModelDefinitionBinding,
  });

  return definition;
}

export const model = ((config: ModelConfig) =>
  bindDefinition(createModel(config))) as typeof createModel;
export const staticModel = ((config: ModelConfig) =>
  bindDefinition(createStaticModel(config))) as typeof createStaticModel;

export { f, fn, createPropsProxy, fieldIn, fieldOut, fieldIsOneWay } from "./fields";
export type {
  Bound,
  Field,
  FieldCodec,
  FieldDef,
  FieldLike,
  FnRequirement,
  IndexKind,
  ItemValue,
  ItemWire,
  Props,
} from "./fields";
export { trait } from "./trait";
export type { TraitConfig, TraitDef } from "./trait";
export { collectModelFieldReads, isModelDefinition, isModelInstance } from "./definition";
export type {
  DescriptorPredicate,
  DescriptorSort,
  FieldDescriptor,
  ModelConfig,
  ModelDefinition,
  ModelFieldReadSource,
  ModelKind,
} from "./definition";
export {
  isModelQuery,
  modelsInspectorSnapshot,
  queryReactivity,
  subscribeInstance,
} from "./collection";
export type { AddOptions, Collection, CollectionInspectorStats, Query } from "./collection";
export { isUnionDefinition, union } from "./union";
export type { UnionDefinition } from "./union";
export { Self, children, inverse, refs } from "./relations";
export type { Cardinality, DeletePolicy, InverseDef, RelationDef, RelationKind } from "./relations";
export type { InstanceOfModel } from "./definition";
export type {
  AddInput,
  AnyModel,
  AnyUnionTyped,
  Descriptors,
  Dto,
  FieldDescriptorTyped,
  FieldStore,
  Impl,
  Instance,
  InstanceApi,
  InstanceOf,
  Model,
  ModelWithDescriptors,
  SelfOf,
  Singleton,
  SingletonOf,
  TraitTyped,
  TypedCollection,
  TypedQuery,
  TypedUnion,
  TypedUnionCollection,
  TypedUnionCollectionBase,
  TypedUnionQuery,
  UnionCollection,
  UnionCommonShape,
  UnionDescriptors,
  UnionQuery,
  UnionTyped,
} from "./types";
