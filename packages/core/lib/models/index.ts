// @virentia/core/models — declaration of models through traits, instance
// storage in collections, field-declared indexes, descriptor queries, codec as
// props bindings. Design: docs/design/dynamic-models.md.

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
export { model, staticModel, isModelDefinition, isModelInstance } from "./definition";
export type {
  DescriptorPredicate,
  DescriptorSort,
  FieldDescriptor,
  ModelConfig,
  ModelDefinition,
  ModelKind,
} from "./definition";
export {
  collection,
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
