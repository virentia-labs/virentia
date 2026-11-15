// Model identity and observation only. Keep this module free of runtime
// imports: renderers must not load factories, registries or TypeBox merely
// to recognize a model. The declarations re-export these exact functions.
import type { Scope } from "../scope/types";
import type { StoreWritable } from "../units/store";
import type { ModelDefinition, InstanceInternal } from "./definition";
import type { FieldDef } from "./fields";
import type { Query } from "./collection";

export const definitionBrand = Symbol("virentia.models.definition");
export const instanceTargetKey = Symbol("virentia.instance.target");

export class InstanceTarget {
  #internal: InstanceInternal;
  #facade!: object;
  constructor(internal: InstanceInternal) {
    this.#internal = internal;
  }
  static state(target: object): InstanceInternal {
    return (target as InstanceTarget).#internal;
  }
  static attach(target: InstanceTarget, facade: object): void {
    target.#facade = facade;
  }
  static lookup(target: unknown, facade: object): InstanceInternal | undefined {
    return typeof target === "object" &&
      target !== null &&
      #internal in target &&
      target.#facade === facade
      ? target.#internal
      : undefined;
  }
  static rawState(target: unknown): InstanceInternal | undefined {
    return typeof target === "object" && target !== null && #internal in target
      ? target.#internal
      : undefined;
  }
}

export function instanceInternalOf(instance: object): InstanceInternal | undefined {
  // The facade's own trap answers with its target: cheaper than a WeakMap,
  // whose first entry per instance cost more than every later lookup saved.
  try {
    return InstanceTarget.lookup(
      (instance as Record<symbol, unknown>)[instanceTargetKey],
      instance,
    );
  } catch {
    // Unknown/revoked proxies are not native facades. Type guards stay total.
    return undefined;
  }
}

export function isModelDefinition(value: unknown): value is ModelDefinition {
  return typeof value === "object" && value !== null && definitionBrand in value;
}

/** Is this value an instance facade produced by a collection? (§10.1) */
export function isModelInstance(value: unknown): boolean {
  return typeof value === "object" && value !== null && instanceInternalOf(value) !== undefined;
}

/** True when the field converts on input but cannot serialize back (§9.1). */
export function fieldIsOneWay(def: FieldDef): boolean {
  return Boolean(def.binding.in) && !def.binding.out;
}

export function isModelQuery(value: unknown): value is Query {
  return typeof value === "object" && value !== null && (value as Query)["~query"] === true;
}

/** What a subscription-based binding needs to follow a query: the epoch stores
 * whose bumps can change the result (one per participating collection). */
export function queryReactivity(query: object): {
  scope: Scope;
  versions: StoreWritable<number>[];
} {
  const marked = query as Query;

  if (marked["~query"] !== true || !marked["~versions"] || !marked["~scope"]) {
    throw new Error("[models] queryReactivity expects a collection query (§10.1)");
  }

  return { scope: marked["~scope"], versions: marked["~versions"]() };
}

/** Per-instance change feed for bindings: own field/relation writes, dispose,
 * rebind. Granularity is the instance — exactly what an entity view renders. */
export function subscribeInstance(instance: object, listener: () => void): () => void {
  const internal = instanceInternalOf(instance);

  if (!internal) {
    throw new Error("[models] subscribeInstance expects a model instance (§10.1)");
  }

  return internal.subscribeSelf ? internal.subscribeSelf(listener) : () => {};
}
