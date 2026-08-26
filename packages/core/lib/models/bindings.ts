import type { Scope } from "../scope/types";

// Lightweight binding protocol shared with framework packages through
// @virentia/core/internal. This module deliberately has no dependency on the
// models implementation (and therefore no dependency on TypeBox).

export const modelDefinitionBinding = Symbol.for("virentia.models.definition.binding");
export const modelInstanceBinding = Symbol.for("virentia.models.instance.binding");

export interface ModelCollectionBinding {
  readonly count: number;
  readonly first: object | null;
  add(input: Record<string, unknown>): object;
}

export interface ModelDefinitionBinding {
  collection(scope: Scope): ModelCollectionBinding;
}

export interface ModelInstanceBinding {
  subscribe(listener: () => void): () => void;
}

export interface ModelVersionBinding {
  subscribe(listener: () => void): () => void;
}

export interface ModelQueryBinding {
  readonly "~query": true;
  readonly "~versions": () => ModelVersionBinding[];
}

export function modelDefinitionBindingOf(value: unknown): ModelDefinitionBinding | undefined {
  return bindingOf<ModelDefinitionBinding>(value, modelDefinitionBinding);
}

export function modelInstanceBindingOf(value: unknown): ModelInstanceBinding | undefined {
  return bindingOf<ModelInstanceBinding>(value, modelInstanceBinding);
}

export function modelQueryBindingOf(value: unknown): ModelQueryBinding | undefined {
  if (!isObject(value)) return undefined;

  const candidate = value as Partial<ModelQueryBinding>;

  return candidate["~query"] === true && typeof candidate["~versions"] === "function"
    ? (candidate as ModelQueryBinding)
    : undefined;
}

function bindingOf<Binding>(value: unknown, key: symbol): Binding | undefined {
  if (!isObject(value)) return undefined;

  return (value as Record<symbol, Binding | undefined>)[key];
}

function isObject(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}
