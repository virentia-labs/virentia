import type { Scope } from "../scope/types";
import {
  collection,
  idsEqual,
  ordKeyOf,
  setUnionCollectionFactory,
  stateOfCollection,
  validateAddInput,
  valuesEqual,
} from "./collection";
import type { AddOptions, Collection, Query } from "./collection";
import { isModelDefinition } from "./definition";
import type { DescriptorPredicate, DescriptorSort, ModelDefinition } from "./definition";
import type { AnyModel, TypedUnion, UnionCollection, UnionQuery } from "./types";

// §5.2: a union is positional — variant identity is a MODEL REFERENCE, never a
// string key. Instances live in their variants' collections; the union
// collection is a view: add routes through `by`, queries merge per-variant
// results, sorting by a common member is a k-way merge over variant indexes.

export interface UnionDefinition {
  readonly "~union": true;
  readonly variants: readonly ModelDefinition[];
  readonly discriminate?: (json: Record<string, unknown>) => ModelDefinition;
  by(discriminate: (json: never) => ModelDefinition): UnionDefinition;
}

const unionBrand = Symbol("virentia.models.union");

export function isUnionDefinition(value: unknown): value is UnionDefinition {
  return typeof value === "object" && value !== null && unionBrand in value;
}

// The one law of commonality (§5.2): a member is common ⇔ EVERY variant carries
// it from the SAME trait, by reference. A name coincidence gives nothing —
// otherwise string identity would sneak back in through the side door.
function computeCommonFields(variants: readonly ModelDefinition[]): {
  common: Set<string>;
  anywhere: Set<string>;
} {
  const anywhere = new Set<string>();

  for (const variant of variants) {
    for (const name of variant.fields.keys()) anywhere.add(name);
  }

  const common = new Set<string>();
  const [first, ...rest] = variants;

  for (const name of first.fields.keys()) {
    const origin = first.fieldOrigins.get(name);

    if (!origin) continue; // the model's own data — no trait reference to share

    if (rest.every((variant) => variant.fields.has(name) && variant.fieldOrigins.get(name) === origin)) {
      common.add(name);
    }
  }

  return { common, anywhere };
}

export function union<const Vs extends readonly AnyModel[]>(...variants: Vs): TypedUnion<Vs, false>;
export function union(...variants: readonly ModelDefinition[]): UnionDefinition;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function union(...variants: readonly ModelDefinition[]): any {
  if (variants.length < 2) {
    throw new Error("[models] union() needs at least two variants — a single model is just the model (§5.2)");
  }

  variants.forEach((variant, index) => {
    if (!isModelDefinition(variant)) {
      throw new Error(`[models] union() variant #${index} is not a model definition (§5.2)`);
    }
  });

  if (new Set(variants).size !== variants.length) {
    throw new Error("[models] union() variants must be distinct models (§5.2)");
  }

  return buildUnion(variants, undefined);
}

function buildUnion(
  variants: readonly ModelDefinition[],
  discriminate: UnionDefinition["discriminate"],
): UnionDefinition {
  const { common, anywhere } = computeCommonFields(variants);
  const descriptors = new Map<string, object>();

  const base = {
    [unionBrand]: true,
    "~union": true as const,
    variants,
    discriminate,

    by(fn: (json: never) => ModelDefinition): UnionDefinition {
      if (typeof fn !== "function") {
        throw new Error("[models] by() expects a discriminator function (json) => Variant (§5.2)");
      }

      return buildUnion(variants, fn as UnionDefinition["discriminate"]);
    },
  };

  return new Proxy(base, {
    get(target, property, receiver) {
      if (typeof property !== "string" || property in target) {
        return Reflect.get(target, property, receiver);
      }

      if (common.has(property)) {
        let descriptor = descriptors.get(property);

        if (!descriptor) {
          descriptor = createUnionDescriptor(receiver as UnionDefinition, property);
          descriptors.set(property, descriptor);
        }

        return descriptor;
      }

      if (anywhere.has(property)) {
        throw new Error(
          `[models] "${property}" is not a common member of this union — a member is common only when every variant carries it from the SAME trait by reference; a name coincidence gives nothing (§5.2)`,
        );
      }

      return undefined;
    },
  }) as UnionDefinition;
}

// Same operator set as model descriptors (§8); `model` is the union itself, and
// query execution translates the predicate per variant so each variant rides
// its own indexes.
function createUnionDescriptor(unionRef: UnionDefinition, field: string): object {
  const predicate = (
    op: DescriptorPredicate["op"],
    value: unknown,
    upper?: unknown,
  ): DescriptorPredicate =>
    ({ "~predicate": true, model: unionRef, field, op, value, upper }) as unknown as DescriptorPredicate;

  return {
    "~descriptor": true,
    model: unionRef,
    field,
    eq: (value: unknown) => predicate("eq", value),
    neq: (value: unknown) => predicate("neq", value),
    gt: (value: unknown) => predicate("gt", value),
    gte: (value: unknown) => predicate("gte", value),
    lt: (value: unknown) => predicate("lt", value),
    lte: (value: unknown) => predicate("lte", value),
    between: (from: unknown, to: unknown) => predicate("between", from, to),
    startsWith: (prefix: string) => predicate("startsWith", prefix),
    includes: (part: unknown) => predicate("includes", part),
    asc: { "~sort": true, model: unionRef, field, direction: "asc" },
    desc: { "~sort": true, model: unionRef, field, direction: "desc" },
  };
}

// ---------------------------------------------------------------------------
// Union collections — get-or-create per (scope, union), like model collections.

interface UnionState {
  definition: UnionDefinition;
  scope: Scope;
  /** materialized eagerly so variant subscriptions exist before any add path. */
  collections: Collection[];
  plans: Map<string, UnionPlanRecord>;
}

interface UnionPlanRecord {
  values: unknown[] | null;
  /** per-variant items-array identities — stable exactly while the variant plan
   * record is stable, which makes them a precise, cheap change key. */
  parts: (object[] | null)[];
  ids: string[];
  items: object[];
}

type UnionFilter =
  | { kind: "descriptor"; predicate: DescriptorPredicate }
  | { kind: "scan"; predicate: (instance: object) => boolean };

interface UnionPlan {
  filters: UnionFilter[];
  /** each match() call contributes one entry per variant index (§5.2). */
  matches: (DescriptorPredicate | boolean)[][];
  sortBy?: { field: string; direction: "asc" | "desc" };
  takeCount?: number;
}

const unionCollectionsByScope = new WeakMap<Scope, Map<UnionDefinition, UnionCollection>>();

setUnionCollectionFactory((definition, scope) =>
  getOrCreateUnionCollection(definition as UnionDefinition, scope),
);

function getOrCreateUnionCollection(definition: UnionDefinition, scope: Scope): UnionCollection {
  let byDefinition = unionCollectionsByScope.get(scope);

  if (!byDefinition) {
    byDefinition = new Map();
    unionCollectionsByScope.set(scope, byDefinition);
  }

  const existing = byDefinition.get(definition);

  if (existing) return existing;

  const state: UnionState = {
    definition,
    scope,
    collections: definition.variants.map((variant) => collection(variant, scope) as Collection),
    plans: new Map(),
  };

  const created = createUnionCollection(state);

  byDefinition.set(definition, created);

  return created;
}

function variantIndexOf(state: UnionState, model: unknown): number {
  return state.definition.variants.indexOf(model as ModelDefinition);
}

function variantLabel(state: UnionState, index: number): string {
  return state.definition.variants[index].name ?? `variant #${index}`;
}

function readField(facade: object, field: string): unknown {
  return (facade as Record<string, { value: unknown }>)[field].value;
}

function assertUnionPredicate(state: UnionState, predicate: DescriptorPredicate): void {
  if ((predicate as { model?: unknown }).model === state.definition) return;

  if (variantIndexOf(state, predicate.model) >= 0) {
    throw new Error(
      `[models] "${predicate.field}" is a variant descriptor — route variant-specific predicates through match(), a union query filters by COMMON members only (§5.2)`,
    );
  }

  throw new Error(
    `[models] descriptor "${predicate.field}" belongs to a different model than this union (§8)`,
  );
}

function assertUnionSort(state: UnionState, by: DescriptorSort): void {
  if ((by as { model?: unknown }).model !== state.definition) {
    throw new Error(
      "[models] union sort takes a COMMON member descriptor of this union (§5.2)",
    );
  }
}

// ---------------------------------------------------------------------------
// add routing (§5.2): a known id merges into its variant WITHOUT `by`; `by`
// decides only for unknown ids — full creations, where shape discrimination is
// sound. A full dto whose shape says variant Y while the id lives in X is a
// migration attempt — a dev error, variants do not migrate.

function isFullInputFor(variant: ModelDefinition, input: Record<string, unknown>): boolean {
  for (const [name, runtime] of variant.fields) {
    const key = runtime.def.binding.key;

    if (key === false) continue;

    const wire = key === null ? name : key;

    if (!runtime.def.defaultValue && !(wire in input)) return false;
  }

  return true;
}

function checkVariantMigration(
  state: UnionState,
  foundIndex: number,
  input: Record<string, unknown>,
): void {
  const { discriminate } = state.definition;

  if (!discriminate) return;

  let indicated: unknown;

  try {
    indicated = discriminate(input);
  } catch {
    return; // partial merge json is outside the discriminator's contract
  }

  const index = variantIndexOf(state, indicated);

  if (index < 0 || index === foundIndex) return;
  if (!isFullInputFor(state.definition.variants[index], input)) return;

  throw new Error(
    `[models] add(): id "${String(input.id)}" already lives in ${variantLabel(state, foundIndex)}, but by() discriminates this json as ${variantLabel(state, index)} — there is no variant migration (§5.2)`,
  );
}

function routeVariantIndex(state: UnionState, input: Record<string, unknown>): number {
  const suppliedId = typeof input.id === "string" ? input.id : undefined;

  if (suppliedId !== undefined) {
    const found = state.collections.findIndex((target) =>
      stateOfCollection(target).instances.has(suppliedId),
    );

    if (found >= 0) {
      checkVariantMigration(state, found, input);

      return found;
    }
  }

  const { discriminate } = state.definition;

  if (!discriminate) {
    throw new Error(
      "[models] this union has no discriminator — declare union(...).by((json) => Variant) to add through the union (§5.2)",
    );
  }

  const target = discriminate(input);
  const index = variantIndexOf(state, target);

  if (index < 0) {
    throw new Error("[models] by() returned a model that is not a variant of this union (§5.2)");
  }

  return index;
}

// ---------------------------------------------------------------------------
// Queries: per-variant pipelines + merge. Reactivity and referential stability
// both delegate to the variant plan records — reading `variant.items` tracks
// that collection's epoch, and its array identity is the memo key here.

function scanIds(): (fn: (instance: object) => boolean) => number {
  const ids = new WeakMap<object, number>();
  let next = 0;

  return (fn) => {
    let id = ids.get(fn);

    if (id === undefined) {
      next += 1;
      id = next;
      ids.set(fn, id);
    }

    return id;
  };
}

const scanIdOf = scanIds();

function unionPlanShape(plan: UnionPlan): { shape: string; values: unknown[] } {
  const parts: string[] = [];
  const values: unknown[] = [];

  const pushPredicate = (prefix: string, predicate: DescriptorPredicate): void => {
    parts.push(`${prefix}:${predicate.field}:${predicate.op}`);
    values.push(predicate.value);

    if (predicate.op === "between") values.push(predicate.upper);
  };

  for (const filter of plan.filters) {
    if (filter.kind === "scan") parts.push(`s${scanIdOf(filter.predicate)}`);
    else pushPredicate("c", filter.predicate);
  }

  for (const match of plan.matches) {
    match.forEach((entry, index) => {
      if (entry === true) parts.push(`m${index}+`);
      else if (entry === false) parts.push(`m${index}-`);
      else pushPredicate(`m${index}`, entry);
    });
  }

  if (plan.sortBy) parts.push(`o:${plan.sortBy.field}:${plan.sortBy.direction}`);
  if (plan.takeCount !== undefined) {
    parts.push("t");
    values.push(plan.takeCount);
  }

  return { shape: parts.join("|"), values };
}

function buildVariantQueries(state: UnionState, plan: UnionPlan): (Query | null)[] {
  return state.collections.map((target, index) => {
    for (const match of plan.matches) {
      if (match[index] === false) return null;
    }

    const variant = state.definition.variants[index];
    let query: Query = target;

    for (const filter of plan.filters) {
      query =
        filter.kind === "scan"
          ? query.where(filter.predicate)
          : query.where({ ...filter.predicate, model: variant } as DescriptorPredicate);
    }

    for (const match of plan.matches) {
      const entry = match[index];

      if (entry !== true && entry !== false) query = query.where(entry);
    }

    if (plan.sortBy) {
      query = query.sort({
        "~sort": true,
        model: variant,
        field: plan.sortBy.field,
        direction: plan.sortBy.direction,
      } as DescriptorSort);
    }

    return query;
  });
}

// Variants come back individually sorted (each by its own index when it has
// one); the union result is their k-way merge, take exits early (§5.2).
function mergeSorted(
  parts: (object[] | null)[],
  sortBy: { field: string; direction: "asc" | "desc" },
  limit: number,
): object[] {
  const keys = parts.map((part) =>
    part === null ? null : part.map((facade) => ordKeyOf(readField(facade, sortBy.field))),
  );
  const cursors = parts.map(() => 0);
  const out: object[] = [];
  const ascending = sortBy.direction === "asc";

  while (out.length < limit) {
    let best = -1;
    let bestKey: unknown;

    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index];

      if (part === null || cursors[index] >= part.length) continue;

      const key = keys[index]![cursors[index]];
      const wins =
        best < 0 ||
        (ascending ? (key as never) < (bestKey as never) : (key as never) > (bestKey as never));

      if (wins) {
        best = index;
        bestKey = key;
      }
    }

    if (best < 0) break;

    out.push(parts[best]![cursors[best]]);
    cursors[best] += 1;
  }

  return out;
}

function partsEqual(a: (object[] | null)[], b: (object[] | null)[]): boolean {
  if (a.length !== b.length) return false;

  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }

  return true;
}

function createUnionQuery(state: UnionState, plan: UnionPlan): UnionQuery {
  const variantQueries = buildVariantQueries(state, plan);
  const { shape, values } = unionPlanShape(plan);

  const resolve = (): UnionPlanRecord => {
    // Reactive reads: each variant's `items` tracks its collection epoch in the
    // caller's collector, and its identity is stable across no-op bumps.
    const parts = variantQueries.map((query) => (query === null ? null : query.items));
    let record = state.plans.get(shape);

    if (record && valuesEqual(record.values, values) && partsEqual(record.parts, parts)) {
      return record;
    }

    const limit = plan.takeCount ?? Number.POSITIVE_INFINITY;
    const items = plan.sortBy
      ? mergeSorted(parts, plan.sortBy, limit)
      : parts
          .flatMap((part) => part ?? [])
          .slice(0, plan.takeCount === undefined ? undefined : plan.takeCount);
    const ids = items.map((facade) => (facade as { id: string }).id);

    if (record && valuesEqual(record.values, values) && idsEqual(record.ids, ids)) {
      record.parts = parts;

      return record;
    }

    record = { values: [...values], parts, ids, items };
    state.plans.set(shape, record);

    return record;
  };

  const query: UnionQuery = {
    "~query": true as const,
    "~scope": state.scope,
    "~versions": () => state.collections.map((target) => stateOfCollection(target).version),

    get items() {
      return resolve().items as never;
    },

    get ids() {
      return resolve().ids;
    },

    get count() {
      return resolve().ids.length;
    },

    get first() {
      return (resolve().items[0] ?? null) as never;
    },

    where(predicate) {
      if (typeof predicate !== "function") {
        assertUnionPredicate(state, predicate as DescriptorPredicate);
      }

      const filter: UnionFilter =
        typeof predicate === "function"
          ? { kind: "scan", predicate: predicate as (instance: object) => boolean }
          : { kind: "descriptor", predicate: predicate as DescriptorPredicate };

      return createUnionQuery(state, { ...plan, filters: [...plan.filters, filter] });
    },

    sort(by) {
      assertUnionSort(state, by as DescriptorSort);

      const token = by as DescriptorSort;

      return createUnionQuery(state, {
        ...plan,
        sortBy: { field: token.field, direction: token.direction },
      });
    },

    take(count) {
      return createUnionQuery(state, { ...plan, takeCount: count });
    },

    match(...branches) {
      const entries: (DescriptorPredicate | boolean)[] = new Array(
        state.definition.variants.length,
      );
      const seen = new Set<number>();

      for (const branch of branches) {
        if (!Array.isArray(branch) || branch.length !== 2 || typeof branch[1] !== "function") {
          throw new Error(
            "[models] match branch must be [Variant, (descriptors) => predicate | boolean] (§5.2)",
          );
        }

        const index = variantIndexOf(state, branch[0]);

        if (index < 0) {
          throw new Error("[models] match branch model is not a variant of this union (§5.2)");
        }

        if (seen.has(index)) {
          throw new Error(
            `[models] match has two branches for ${variantLabel(state, index)} (§5.2)`,
          );
        }

        seen.add(index);

        const result = (branch[1] as (descriptors: unknown) => unknown)(
          state.definition.variants[index],
        );

        if (typeof result === "boolean") {
          entries[index] = result;
        } else if (
          typeof result === "object" &&
          result !== null &&
          (result as { "~predicate"?: unknown })["~predicate"] === true
        ) {
          if ((result as DescriptorPredicate).model !== state.definition.variants[index]) {
            throw new Error(
              `[models] match branch for ${variantLabel(state, index)} returned a predicate built from another model's descriptors (§5.2)`,
            );
          }

          entries[index] = result as DescriptorPredicate;
        } else {
          throw new Error(
            "[models] match branch must return a descriptor predicate or a boolean literal (§5.2)",
          );
        }
      }

      if (seen.size < state.definition.variants.length) {
        const missing = state.definition.variants
          .map((_, index) => index)
          .filter((index) => !seen.has(index))
          .map((index) => variantLabel(state, index));

        throw new Error(
          `[models] match must be exhaustive — missing: ${missing.join(", ")} (§5.2)`,
        );
      }

      return createUnionQuery(state, { ...plan, matches: [...plan.matches, entries] });
    },

    select(descriptor) {
      const token = descriptor as unknown as DescriptorPredicate;

      if ((token as { model?: unknown }).model !== state.definition) {
        throw new Error("[models] union select takes a COMMON member descriptor (§5.2)");
      }

      return resolve().items.map((facade) => readField(facade, token.field)) as never;
    },

    set(descriptor, value) {
      const token = descriptor as unknown as DescriptorPredicate;

      if ((token as { model?: unknown }).model !== state.definition) {
        throw new Error("[models] union set takes a COMMON member descriptor (§5.2)");
      }

      for (const facade of resolve().items) {
        (facade as Record<string, { value: unknown }>)[token.field].value = value;
      }
    },

    remove() {
      for (const facade of [...resolve().items]) {
        (facade as { dispose(): void }).dispose();
      }
    },

    toArray() {
      return [...(resolve().items as never[])];
    },

    [Symbol.iterator]() {
      return (resolve().items as never[])[Symbol.iterator]();
    },
  };

  return query;
}

function createUnionCollection(state: UnionState): UnionCollection {
  const emptyPlan: UnionPlan = { filters: [], matches: [] };

  const addOne = (input: Record<string, unknown>, options?: AddOptions): object => {
    const index = routeVariantIndex(state, input);

    return state.collections[index].add(input, options);
  };

  const self: UnionCollection = Object.assign(createUnionQuery(state, emptyPlan), {
    "~unionCollection": true as const,
    model: state.definition,
    scope: state.scope,
    variants: state.definition.variants,

    add(
      input: Record<string, unknown> | readonly Record<string, unknown>[],
      options?: AddOptions,
    ) {
      if (Array.isArray(input)) {
        // §3.1 batch semantics across variants: route + validate everything
        // first, then apply; a mid-apply failure rolls back this batch's
        // creations in whichever variants they landed.
        const targets = input.map((entry) => routeVariantIndex(state, entry));

        input.forEach((entry, position) => {
          validateAddInput(stateOfCollection(state.collections[targets[position]]), entry, options);
        });

        const created: object[] = [];

        try {
          return input.map((entry, position) => {
            const target = state.collections[targets[position]];
            const suppliedId = typeof entry.id === "string" ? entry.id : undefined;
            const isCreation =
              suppliedId === undefined || !stateOfCollection(target).instances.has(suppliedId);
            const facade = target.add(entry, options) as object;

            if (isCreation) created.push(facade);

            return facade;
          });
        } catch (error) {
          for (const facade of created) {
            (facade as { dispose(): void }).dispose();
          }

          throw error;
        }
      }

      return addOne(input as Record<string, unknown>, options);
    },

    get(id: string) {
      for (const target of state.collections) {
        const hit = target.get(id);

        if (hit) return hit;
      }

      return null;
    },

    remove(id: string) {
      for (const target of state.collections) {
        if (stateOfCollection(target).instances.has(id)) {
          target.remove(id);

          return;
        }
      }
    },
  }) as unknown as UnionCollection;

  return self;
}
