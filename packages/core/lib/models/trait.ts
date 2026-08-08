import { Type } from "@sinclair/typebox";
import type { TSchema } from "@sinclair/typebox";
import { createPropsProxy, isFieldDef, isFnRequirement } from "./fields";
import type { AnyField, Field, FieldDef, FnRequirement, Props } from "./fields";
import { isInverseDef, isRelationDef } from "./relations";
import type { InverseDef, RelationDef } from "./relations";
import type {
  AnyTraitTyped,
  MembersRecord,
  SelfOf,
  ShapeRecord,
  TraitTyped,
  TraitsMembers,
  TraitsProps,
  TraitsRequiredBehaviors,
  TraitsShape,
} from "./types";

// A trait mixes an interface with an abstract class (§4.1): `requires` only
// demands (field schema or behavior signature) and never stores; `data` only
// declares and always stores. Identity is the trait object itself — no names.

export type DataEntry = AnyField | RelationDef<any, any, any> | InverseDef<any>;

export type DataDeclaration =
  | Record<string, DataEntry>
  | ((props: never) => Record<string, DataEntry>);

export interface TraitConfig {
  with?: readonly TraitDef[];
  requires?: Record<string, Field<unknown> | FnRequirement>;
  data?: DataDeclaration;
  setup?: (self: never) => Record<string, unknown> | void;
}

export interface TraitDef {
  readonly "~trait": true;
  readonly with: readonly TraitDef[];
  readonly requires: Readonly<Record<string, FieldDef | FnRequirement>>;
  /** Resolved once at declaration: function-form data has already run with the Props proxy. */
  readonly fields: ReadonlyMap<string, FieldDef>;
  readonly relations: ReadonlyMap<string, RelationDef | InverseDef>;
  readonly setup?: (self: never) => Record<string, unknown> | void;
  /** Generic application (§4.5): `Keyed(f.string())` instantiates Argument placeholders. */
  (...args: readonly Field<unknown>[]): TraitDef;
}

const traitBrand = Symbol("virentia.models.trait");

export function isTrait(value: unknown): value is TraitDef {
  return (typeof value === "object" || typeof value === "function") && value !== null
    && traitBrand in (value as object);
}

export interface ResolvedData {
  fields: Map<string, FieldDef>;
  relations: Map<string, RelationDef | InverseDef>;
}

/** Resolves a `data` declaration into ordered tables (runs function form ONCE, §3.1). */
export function resolveDataDeclaration(data: DataDeclaration | undefined): ResolvedData {
  const fields = new Map<string, FieldDef>();
  const relations = new Map<string, RelationDef | InverseDef>();

  if (!data) return { fields, relations };

  const functionForm = typeof data === "function";
  const record = functionForm
    ? (data as (props: never) => Record<string, DataEntry>)(createPropsProxy() as never)
    : (data as Record<string, DataEntry>);

  for (const [name, entry] of Object.entries(record)) {
    if (isRelationDef(entry) || isInverseDef(entry)) {
      relations.set(name, entry);
      continue;
    }

    if (!isFieldDef(entry)) {
      throw new Error(
        `[models] data.${name} is not a field or relation — use f.* / refs / children / inverse`,
      );
    }

    // Extract the canonical data record — the builder wrapper's chainable
    // methods shadow same-named data keys (`indexed`, `unique`).
    const clean = ((entry as { "~def"?: FieldDef })["~def"] ?? entry) as FieldDef;

    // §3.1: in function form locality IS unboundness — a field that took no
    // Bound is off the wire; by-name binding is the object-form shorthand only.
    const resolved =
      functionForm && clean.binding.key === null
        ? ({ ...clean, binding: { ...clean.binding, key: false as const } } as FieldDef)
        : clean;

    fields.set(name, resolved);
  }

  return { fields, relations };
}

type ReqFieldsShape<Req> = {
  [K in keyof Req & string as Req[K] extends AnyField ? K : never]: Req[K] extends AnyField
    ? Req[K]
    : never;
};

type ReqBehaviors<Req> = {
  [K in keyof Req & string as Req[K] extends FnRequirement<any> ? K : never]: Req[K] extends {
    "~signature"?: infer Fn;
  }
    ? Fn
    : never;
};

export function trait<
  const W extends readonly (TraitDef & AnyTraitTyped)[] = [],
  S extends Record<string, unknown> = {},
  R extends ShapeRecord = {},
  Req extends Record<string, AnyField | FnRequirement<any>> = {},
  M extends MembersRecord | void = void,
>(config: {
  with?: W;
  requires?: Req;
  data?: R | ((props: Props<S>) => R);
  setup?: (
    self: SelfOf<
      R & ReqFieldsShape<Req> & TraitsShape<W>,
      TraitsMembers<W>,
      ReqBehaviors<Req> & TraitsRequiredBehaviors<W>
    >,
  ) => M;
}): TraitDef &
  TraitTyped<
    R,
    M extends void ? {} : M,
    ReqFieldsShape<Req>,
    ReqBehaviors<Req>,
    S & TraitsProps<W>
  >;
export function trait(config: TraitConfig): TraitDef;
export function trait(config: TraitConfig): TraitDef {
  const { fields, relations } = resolveDataDeclaration(config.data);
  const requires: Record<string, FieldDef | FnRequirement> = {};

  for (const [name, requirement] of Object.entries(config.requires ?? {})) {
    if (!isFieldDef(requirement) && !isFnRequirement(requirement)) {
      throw new Error(`[models] requires.${name} must be a field schema or fn<...>()`);
    }

    requires[name] = isFieldDef(requirement)
      ? (((requirement as { "~def"?: FieldDef })["~def"] ?? requirement) as FieldDef)
      : requirement;
  }

  return buildTrait(config.with ?? [], requires, fields, relations, config.setup);
}

function buildTrait(
  withTraits: readonly TraitDef[],
  requires: Record<string, FieldDef | FnRequirement>,
  fields: ReadonlyMap<string, FieldDef>,
  relations: ReadonlyMap<string, RelationDef | InverseDef>,
  setup: TraitConfig["setup"],
  appliedFrom?: TraitDef,
): TraitDef {
  // Application is NOT a factory (§4.5): the applied trait keeps the original's
  // identity through `~origin`, the way a generic instantiation keeps the generic.
  const apply = (...args: readonly Field<unknown>[]): TraitDef => {
    const schemas = args.map((argument) => argument.schema);
    const instantiated = new Map<string, FieldDef>();

    for (const [name, field] of fields) {
      instantiated.set(name, { ...field, schema: instantiateSchema(field.schema, schemas) });
    }

    const instantiatedRequires: Record<string, FieldDef | FnRequirement> = {};

    for (const [name, requirement] of Object.entries(requires)) {
      instantiatedRequires[name] = isFieldDef(requirement)
        ? { ...requirement, schema: instantiateSchema(requirement.schema, schemas) }
        : requirement;
    }

    return buildTrait(withTraits, instantiatedRequires, instantiated, relations, setup, self);
  };

  const self = Object.assign(apply, {
    [traitBrand]: true,
    "~trait": true as const,
    with: withTraits,
    requires,
    fields,
    relations,
    setup,
    "~origin": undefined as TraitDef | undefined,
  });

  self["~origin"] = appliedFrom ?? (self as unknown as TraitDef);

  return self as unknown as TraitDef;
}

function instantiateSchema(schema: TSchema, args: readonly TSchema[]): TSchema {
  return Type.Instantiate(schema as never, args as never) as TSchema;
}

/** One trait shared through several paths composes once: dedupe by application origin. */
export function traitIdentity(traitDef: TraitDef): TraitDef {
  return ((traitDef as unknown as { "~origin"?: TraitDef })["~origin"] ?? traitDef) as TraitDef;
}

export interface ComposedShape {
  /** name → declaration, exactly one declaring site per name (§4.6). */
  fields: Map<string, FieldDef>;
  relations: Map<string, RelationDef | InverseDef>;
  /** Behavior names that must be implemented by some setup return. */
  behaviors: Set<string>;
  /** Traits in composition order (deduped), model's own data resolved separately. */
  traits: TraitDef[];
  /** field → declaring trait IDENTITY; absent — the model's own data. Union
   * commonality (§5.2) is decided by this reference, never by the name. */
  origins: Map<string, TraitDef>;
}

// The law of names (§4.6): any number of participants may REQUIRE a name,
// exactly one may DECLARE it. Two declarations — collision; a field requirement
// left undeclared — error; a behavior requirement is checked after setups run.
export function composeShape(
  withTraits: readonly TraitDef[],
  ownFields: ReadonlyMap<string, FieldDef>,
  ownRelations: ReadonlyMap<string, RelationDef | InverseDef>,
): ComposedShape {
  const traits: TraitDef[] = [];
  const seen = new Set<TraitDef>();

  const visit = (traitDef: TraitDef): void => {
    const identity = traitIdentity(traitDef);

    if (seen.has(identity)) return;

    seen.add(identity);

    for (const parent of traitDef.with) visit(parent);

    traits.push(traitDef);
  };

  for (const traitDef of withTraits) visit(traitDef);

  const fields = new Map<string, FieldDef>();
  const relations = new Map<string, RelationDef | InverseDef>();
  const behaviors = new Set<string>();
  const fieldRequirements = new Map<string, FieldDef>();
  const origins = new Map<string, TraitDef>();

  const taken = (name: string): boolean => fields.has(name) || relations.has(name);

  const declare = (name: string, source: string): void => {
    if (taken(name)) {
      throw new Error(
        `[models] declaration collision on "${name}": it is declared by two composition participants (${source}); exactly one may declare, the rest must require (§4.6)`,
      );
    }
  };

  for (const traitDef of traits) {
    for (const [name, field] of traitDef.fields) {
      declare(name, "trait data");
      fields.set(name, field);
      origins.set(name, traitIdentity(traitDef));
    }

    for (const [name, relationDef] of traitDef.relations) {
      declare(name, "trait data");
      relations.set(name, relationDef);
    }

    for (const [name, requirement] of Object.entries(traitDef.requires)) {
      if (isFnRequirement(requirement)) {
        behaviors.add(name);
      } else {
        fieldRequirements.set(name, requirement);
      }
    }
  }

  for (const [name, field] of ownFields) {
    declare(name, "model data");
    fields.set(name, field);
  }

  for (const [name, relationDef] of ownRelations) {
    declare(name, "model data");
    relations.set(name, relationDef);
  }

  for (const name of fieldRequirements.keys()) {
    if (!fields.has(name)) {
      throw new Error(
        `[models] model does not declare required field "${name}" — a trait requires it; declare it in data (§4.6)`,
      );
    }
  }

  return { fields, relations, behaviors, traits, origins };
}
