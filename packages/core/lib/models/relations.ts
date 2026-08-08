import type { ModelDefinition } from "./definition";

// §5: two relation kinds — `children` (composition: lifetime bound to the
// parent) and `refs` (association: the target lives on its own), cardinality as
// a modifier. `inverse` is a storage-less VIEW over the owning side (§5.3).
// A relation is declared in `data` like a field, but stores only ids: refs.one
// keeps a target id (or null), refs.many/children.many keep an ordered id list.

export type RelationKind = "refs" | "children";
export type Cardinality = "one" | "many";
export type DeletePolicy = "restrict" | "nullify" | "orphan";

/** Self marker (§5.4): "this model" in a model, "the implementing model" in a trait. */
export const Self: unique symbol = Symbol("virentia.models.Self");

/** Structural view of a union target (§5.2) — declared here, not imported from
 * union.ts, so the relations module stays out of the union→collection cycle. */
export interface UnionTargetLike {
  readonly "~union": true;
  readonly variants: readonly ModelDefinition[];
  readonly discriminate?: (json: Record<string, unknown>) => ModelDefinition;
}

export function isUnionTargetLike(value: unknown): value is UnionTargetLike {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { "~union"?: unknown })["~union"] === true
  );
}

export type ResolvedRelationTarget = ModelDefinition | UnionTargetLike;

export type RelationTarget =
  | ModelDefinition
  | UnionTargetLike
  | (() => ModelDefinition | UnionTargetLike)
  | typeof Self;

/**
 * TR — the captured target reference type: a definition, a LAZY thunk type
 * (never its return — §5.4), or the Self marker.
 */
export interface RelationDef<
  TR = unknown,
  RK extends RelationKind = RelationKind,
  C extends Cardinality = Cardinality,
> {
  readonly kind: "relation";
  readonly relation: RK;
  readonly cardinality: C;
  readonly target: RelationTarget;
  readonly "~target"?: TR;
  /** data flags live under names DISTINCT from the chainable methods below. */
  readonly isUnique?: boolean;
  readonly onDelete?: DeletePolicy;
  /** wire key; null — by field name (relations are always on the wire unless inverse). */
  readonly wireKey: string | null;
  /** resolved lazily on first navigation (§5.4), cached here. */
  resolvedTarget?: ResolvedRelationTarget;
  /** set when the target resolves against a concrete owning definition (Self). */
  owner?: ModelDefinition;
}

export interface InverseDef<F = unknown> {
  readonly kind: "inverse";
  readonly owning: () => { model: ModelDefinition; field: string };
  readonly "~owning"?: F;
  resolved?: { model: ModelDefinition; field: string };
}

export type AnyRelationDef = RelationDef<any, any, any>;
export type AnyInverseDef = InverseDef<any>;

export function isRelationDef(value: unknown): value is AnyRelationDef {
  return typeof value === "object" && value !== null && (value as RelationDef).kind === "relation";
}

export function isInverseDef(value: unknown): value is AnyInverseDef {
  return typeof value === "object" && value !== null && (value as InverseDef).kind === "inverse";
}

interface RelationOptions {
  unique?: boolean;
  policy?: DeletePolicy;
  wireKey?: string;
}

function relation(
  relationKind: RelationKind,
  cardinality: Cardinality,
  target: RelationTarget,
  options: RelationOptions = {},
): AnyRelationDef {
  return {
    kind: "relation",
    relation: relationKind,
    cardinality,
    target,
    isUnique: options.unique,
    onDelete: options.policy,
    wireKey: options.wireKey ?? null,
  };
}

export type RelationBuilder<TR, RK extends RelationKind, C extends Cardinality> = RelationDef<
  TR,
  RK,
  C
> & {
  unique(): RelationDef<TR, RK, C>;
  policy(policy: DeletePolicy): RelationDef<TR, RK, C>;
};

function withModifiers(def: AnyRelationDef): RelationBuilder<unknown, RelationKind, Cardinality> {
  return {
    ...def,

    unique() {
      return withModifiers({ ...def, isUnique: true });
    },

    policy(policy: DeletePolicy) {
      return withModifiers({ ...def, onDelete: policy });
    },
  } as RelationBuilder<unknown, RelationKind, Cardinality>;
}

// Overload shape is the §5.4 invariant made syntax: a value target is captured
// as ITSELF (model or union), a thunk is captured as its FUNCTION type
// (`F extends () => void` — laziness survives exactly this constraint), Self as
// the marker type.
interface RelationFactory<RK extends RelationKind, C extends Cardinality> {
  (target: typeof Self, options?: RelationOptions): RelationBuilder<typeof Self, RK, C>;
  <F extends () => void>(target: F, options?: RelationOptions): RelationBuilder<F, RK, C>;
  <U extends UnionTargetLike>(target: U, options?: RelationOptions): RelationBuilder<U, RK, C>;
  <M extends ModelDefinition>(target: M, options?: RelationOptions): RelationBuilder<M, RK, C>;
}

function relationFactory<RK extends RelationKind, C extends Cardinality>(
  relationKind: RK,
  cardinality: C,
): RelationFactory<RK, C> {
  return ((target: RelationTarget, options?: RelationOptions) =>
    withModifiers(relation(relationKind, cardinality, target, options))) as RelationFactory<RK, C>;
}

export const refs = {
  one: relationFactory("refs", "one"),
  many: relationFactory("refs", "many"),
};

export const children = {
  one: relationFactory("children", "one"),
  many: relationFactory("children", "many"),
};

export function inverse<F extends () => void>(owning: F): InverseDef<F> {
  return { kind: "inverse", owning: owning as never };
}

// ---------------------------------------------------------------------------
// Lazy target resolution (§5.4): value | thunk | Self, nothing else — the value
// may be a model or a union (§5.2). The thunk runs at first navigation, never
// at declaration (TDZ), and its result is validated with a named error.

import { isModelDefinition } from "./definition";

export function resolveRelationTarget(def: RelationDef): ResolvedRelationTarget {
  if (def.resolvedTarget) return def.resolvedTarget;

  let target: unknown = def.target;

  if (target === Self) {
    if (!def.owner) {
      throw new Error("[models] Self relation used outside a model definition");
    }

    target = def.owner;
  } else if (typeof target === "function" && !isModelDefinition(target)) {
    target = (target as () => unknown)();
  }

  if (!isModelDefinition(target) && !isUnionTargetLike(target)) {
    throw new Error(
      `[models] relation target thunk returned ${describeValue(target)}, expected a model definition or a union (§5.4)`,
    );
  }

  def.resolvedTarget = target;

  return target;
}

export function resolveInverseOwning(def: InverseDef): { model: ModelDefinition; field: string } {
  if (def.resolved) return def.resolved;

  const owning = def.owning();
  const model = (owning as { model?: unknown })?.model;
  const field = (owning as { field?: unknown })?.field;

  if (!isModelDefinition(model) || typeof field !== "string") {
    throw new Error(
      `[models] inverse() expects a thunk of an owning FIELD descriptor (() => Model.field), got ${describeValue(owning)} (§5.3)`,
    );
  }

  def.resolved = { model, field };

  return def.resolved;
}

function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";

  return typeof value === "object" || typeof value === "function"
    ? Object.prototype.toString.call(value)
    : String(value);
}
