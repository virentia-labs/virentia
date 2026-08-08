import type { Scope } from "../scope/types";
import type { AnyField, FieldDef } from "./fields";
import type { AnyInverseDef, AnyRelationDef, RelationDef, Self } from "./relations";
import type { ModelDefinition } from "./definition";

// ---------------------------------------------------------------------------
// The public type algebra of @virentia/core/models. Everything here follows the
// §5.4 laziness invariant: a relation's thunk type is dereferenced ONLY inside
// property-position conditionals (`F extends () => infer M`), never while a
// definition's own type is being computed — that is what lets mutual model
// cycles infer with zero annotations (verified in scratchpad mutual/).

export type DataEntryAny = AnyField | AnyRelationDef | AnyInverseDef;
export type ShapeRecord = Record<string, DataEntryAny>;
export type MembersRecord = Record<string, unknown>;

/** Trait/shape intersections may drag in an index signature (`& ShapeRecord`);
 * every key mapping strips it first, or concrete keys dissolve into `string`. */
export type ConcreteKeys<T> = {
  [K in keyof T as string extends K ? never : K extends string ? K : never]: T[K];
};

// Entry probes go through the `kind` discriminant + phantom indexed access:
// builder wrappers shadow data props with methods, so `E extends FieldDef<...>`
// does NOT hold for them — but `kind` and the phantoms always survive.
type IsFieldEntry<E> = E extends { kind: "field" } ? true : false;
type FieldValueOf<E> = E extends { "~value"?: infer T } ? Exclude<T, undefined> : never;
type FieldKeyOf<E> = E extends { "~key"?: infer K } ? Exclude<K, undefined> : never;
type FieldOptOf<E> = E extends { "~opt"?: infer O } ? Exclude<O, undefined> : never;
type FieldWireOf<E> = E extends { "~wireType"?: infer W } ? Exclude<W, undefined> : never;
type RelationTargetOf<E> = E extends { "~target"?: infer TR } ? Exclude<TR, undefined> : never;

/** The store surface of a field on `self` and on the instance (§8). */
export interface FieldStore<T> {
  value: T;
  readonly node: unknown;
  subscribe(fn: (value: T, scope: Scope) => void): () => void;
}

export interface InstanceApi {
  readonly id: string;
  readonly key: string;
  readonly alive: boolean;
  json(): Record<string, unknown>;
  dispose(): void;
  rebind(newId: string): void;
  /** Attach an external cleanup to the instance's lifetime (§10.4); returns unregister. */
  onCleanup(cleanup: () => void): () => void;
}

// --- relation surfaces ------------------------------------------------------

/** Lazy target deref (§5.4): value → itself, thunk → its return, Self → fallback. */
type TargetModelOf<TR, SelfFallback> = TR extends typeof Self
  ? SelfFallback
  : TR extends () => infer M
    ? M
    : TR;

/** A union target's variants, distributed (§5.2). */
type VariantModelsOfTarget<M> = M extends UnionTyped<infer Vs, any>
  ? Vs extends readonly AnyModel[]
    ? Vs[number]
    : never
  : never;

type TargetInstanceOf<TR, SelfInstance> = TR extends typeof Self
  ? SelfInstance
  : TargetModelOf<TR, never> extends infer M
    ? M extends AnyModel
      ? InstanceOf<M>
      : M extends UnionTyped<any, any>
        ? DistributeInstance<VariantModelsOfTarget<M>>
        : object
    : object;

export interface RefsOneView<Target> {
  value: Target | null;
}

export interface RefsManyView<Target> {
  add(target: Target | string): void;
  remove(target: Target | string): void;
  readonly ids: string[];
  readonly items: Target[];
  readonly count: number;
}

export interface ChildrenManyView<Target, TargetDto> {
  add(input: TargetDto): Target;
  add(input: readonly TargetDto[]): Target[];
  remove(target: Target | string): void;
  move(target: Target | string, index: number): void;
  readonly ids: string[];
  readonly items: Target[];
  readonly count: number;
}

export interface ChildrenOneView<Target, TargetDto> {
  readonly value: Target | null;
  create(input: TargetDto): Target;
  clear(): void;
}

/** Inverse views are intentionally loose in v1: link/unlink + reads. */
export interface InverseManyView {
  readonly ids: string[];
  readonly items: object[];
  readonly count: number;
  link(owner: object | string): void;
  unlink(owner: object | string): void;
}

export interface InverseOneView {
  readonly value: object | null;
}

type TargetDtoOf<TR, SelfInstance> = TargetModelOf<TR, never> extends infer M
  ? M extends AnyModel
    ? AddInput<M>
    : M extends UnionTyped<any, any>
      ? DistributeAddInput<VariantModelsOfTarget<M>>
      : Record<string, unknown>
  : Record<string, unknown>;

type SurfaceOfEntry<E, SelfInstance> = E extends { kind: "field" }
  ? FieldStore<FieldValueOf<E>>
  : E extends { kind: "relation"; relation: infer RK; cardinality: infer C }
    ? RK extends "refs"
      ? C extends "one"
        ? RefsOneView<TargetInstanceOf<RelationTargetOf<E>, SelfInstance>>
        : RefsManyView<TargetInstanceOf<RelationTargetOf<E>, SelfInstance>>
      : C extends "one"
        ? ChildrenOneView<
            TargetInstanceOf<RelationTargetOf<E>, SelfInstance>,
            TargetDtoOf<RelationTargetOf<E>, SelfInstance>
          >
        : ChildrenManyView<
            TargetInstanceOf<RelationTargetOf<E>, SelfInstance>,
            TargetDtoOf<RelationTargetOf<E>, SelfInstance>
          >
    : E extends { kind: "inverse" }
      ? InverseManyView | InverseOneView
      : never;

// --- instances ---------------------------------------------------------------

export interface AnyModel extends ModelDefinition {
  readonly "~shape"?: ShapeRecord;
  readonly "~members"?: MembersRecord;
  readonly "~props"?: Record<string, unknown>;
}

export interface Model<
  Shape extends ShapeRecord = ShapeRecord,
  Members extends MembersRecord = MembersRecord,
  PropsShape extends Record<string, unknown> = Record<string, unknown>,
> extends ModelDefinition {
  readonly "~shape"?: Shape;
  readonly "~members"?: Members;
  readonly "~props"?: PropsShape;
  create(input: DtoFromShape<Shape> | ({ id: string } & Partial<DtoFromShape<Shape>>)): Instance<
    Shape,
    Members
  >;
}

type IsAny<T> = 0 extends 1 & T ? true : false;

/** §3.1, type side of «в функциональной форме локальность — несвязанность»:
 * a field declared without a Bound in function-form data is rewritten to a
 * local (off-the-wire) key, mirroring the runtime resolveDataDeclaration. */
export type LocalizeUnbound<R> = {
  [K in keyof R]: R[K] extends { kind: "field" }
    ? [FieldKeyOf<R[K]>] extends [null]
      ? FieldWithKey<R[K], false>
      : R[K]
    : R[K];
};

type FieldWithKey<E, K2 extends string | null | false> = E extends { kind: "field" }
  ? import("./fields").Field<
      FieldValueOf<E>,
      K2,
      FieldOptOf<E> extends boolean ? FieldOptOf<E> : boolean,
      FieldWireOf<E>
    >
  : E;

/** Phantom extraction — NEVER match the Model interface structurally: its
 * `create` references the Dto of itself, and that circular inference silently
 * collapses `infer Shape` into the constraint. Phantoms are inert. */
export type ShapeOf<M> = M extends { "~shape"?: infer S }
  ? NonNullable<S> extends ShapeRecord
    ? NonNullable<S>
    : never
  : never;

export type MembersOf<M> = M extends { "~members"?: infer S }
  ? NonNullable<S> extends MembersRecord
    ? NonNullable<S>
    : never
  : never;

/** Descriptor space of a model: `Todo.done`, `Todo.priority.gte(3)` (§8). */
export type Descriptors<Shape extends ShapeRecord> = {
  readonly [K in keyof ConcreteKeys<Shape> & string]: DescriptorOf<ConcreteKeys<Shape>[K], K>;
};

export type ModelWithDescriptors<
  Shape extends ShapeRecord,
  Members extends MembersRecord,
  PropsShape extends Record<string, unknown>,
> = Model<Shape, Members, PropsShape> & Descriptors<Shape>;

export type Instance<Shape extends ShapeRecord, Members extends MembersRecord> = {
  readonly [K in keyof ConcreteKeys<Shape> & string]: SurfaceOfEntry<
    ConcreteKeys<Shape>[K],
    unknown
  >;
} & Readonly<ConcreteKeys<Members>> &
  InstanceApi;

export type InstanceOf<M> = IsAny<M> extends true
  ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
    any
  : [ShapeOf<M>] extends [never]
    ? object
    : Instance<ShapeOf<M>, MembersOf<M>>;

// --- Dto (§9.1): the wire shape derived from bindings ------------------------

type WireKeyOfField<E, Name extends string> = FieldKeyOf<E> extends infer K
  ? K extends string
    ? K
    : K extends null
      ? Name
      : never // local — off the wire
  : never;

type FieldIsOptional<E> = FieldOptOf<E> extends true ? true : false;

type WireValueOfField<E> = FieldWireOf<E>;

type RelationWireValue<E> = E extends { kind: "relation"; relation: infer RK; cardinality: infer C }
  ? RK extends "refs"
    ? C extends "one"
      ? string | null
      : string[]
    : C extends "one"
      ? Record<string, unknown> | null
      : Record<string, unknown>[]
  : never;

type RequiredFieldKeys<Shape> = {
  [K in keyof Shape & string]: IsFieldEntry<Shape[K]> extends true
    ? FieldIsOptional<Shape[K]> extends true
      ? never
      : [WireKeyOfField<Shape[K], K>] extends [never]
        ? never
        : K
    : never;
}[keyof Shape & string];

type OptionalFieldKeys<Shape> = {
  [K in keyof Shape & string]: IsFieldEntry<Shape[K]> extends true
    ? FieldIsOptional<Shape[K]> extends true
      ? [WireKeyOfField<Shape[K], K>] extends [never]
        ? never
        : K
      : never
    : never;
}[keyof Shape & string];

type RelationKeys<Shape> = {
  [K in keyof Shape & string]: Shape[K] extends { kind: "relation" } ? K : never;
}[keyof Shape & string];

type DtoFromConcrete<Shape> = {
  [K in RequiredFieldKeys<Shape> as WireKeyOfField<Shape[K], K>]: WireValueOfField<Shape[K]>;
} & {
  [K in OptionalFieldKeys<Shape> as WireKeyOfField<Shape[K], K>]?: WireValueOfField<Shape[K]>;
} & { [K in RelationKeys<Shape>]?: RelationWireValue<Shape[K]> } & { id?: string };

export type DtoFromShape<Shape extends ShapeRecord> = DtoFromConcrete<ConcreteKeys<Shape>>;

export type Dto<M> = IsAny<M> extends true
  ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
    any
  : [ShapeOf<M>] extends [never]
    ? Record<string, unknown>
    : DtoFromShape<ShapeOf<M>>;

export type AddInput<M> = Dto<M> | ({ id: string } & Partial<Dto<M>>);

// --- descriptors and queries (§8) --------------------------------------------

export interface Predicate<T = unknown> {
  readonly "~predicate": true;
  readonly model: ModelDefinition;
  readonly field: string;
  readonly op: string;
  readonly value: unknown;
  readonly upper?: unknown;
  readonly "~valueType"?: T;
}

export interface SortToken {
  readonly "~sort": true;
  readonly model: ModelDefinition;
  readonly field: string;
  readonly direction: "asc" | "desc";
}

export type DescriptorOf<E, Name extends string> = E extends { kind: "field" }
  ? FieldDescriptorTyped<FieldValueOf<E>, FieldWireOf<E>>
  : E extends { kind: "relation" } | { kind: "inverse" }
    ? RelationDescriptor
    : never;

export interface FieldDescriptorTyped<T, W = T> {
  readonly "~descriptor": true;
  readonly model: ModelDefinition;
  readonly field: string;
  eq(value: T | W): Predicate<T>;
  neq(value: T | W): Predicate<T>;
  gt(value: T | W): Predicate<T>;
  gte(value: T | W): Predicate<T>;
  lt(value: T | W): Predicate<T>;
  lte(value: T | W): Predicate<T>;
  between(from: T | W, to: T | W): Predicate<T>;
  startsWith(prefix: T extends string ? string : never): Predicate<T>;
  includes(part: unknown): Predicate<T>;
  readonly asc: SortToken;
  readonly desc: SortToken;
}

export interface RelationDescriptor {
  readonly "~descriptor": true;
  readonly model: ModelDefinition;
  readonly field: string;
}

export interface TypedQuery<Inst> extends Iterable<Inst> {
  readonly items: Inst[];
  readonly ids: string[];
  readonly count: number;
  readonly first: Inst | null;
  where(predicate: Predicate<any> | ((instance: Inst) => boolean)): TypedQuery<Inst>;
  sort(by: SortToken): TypedQuery<Inst>;
  take(count: number): TypedQuery<Inst>;
  select<T>(descriptor: FieldDescriptorTyped<T, any>): T[];
  set<T>(descriptor: FieldDescriptorTyped<T, any>, value: T): void;
  remove(id?: string): void;
  toArray(): Inst[];
}

export interface TypedCollection<M extends AnyModel> extends TypedQuery<InstanceOf<M>> {
  readonly model: M;
  readonly scope: Scope;
  add(input: AddInput<M>, options?: { replace?: boolean }): InstanceOf<M>;
  add(input: readonly AddInput<M>[], options?: { replace?: boolean }): InstanceOf<M>[];
  get(id: string): InstanceOf<M> | null;
  remove(id: string): void;
}

// --- traits ------------------------------------------------------------------

export interface TraitTyped<
  Shape extends ShapeRecord = ShapeRecord,
  Members extends MembersRecord = MembersRecord,
  ReqShape extends ShapeRecord = ShapeRecord,
  ReqBehaviors extends MembersRecord = MembersRecord,
  PropsShape extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly "~trait": true;
  readonly "~tshape"?: Shape;
  readonly "~tmembers"?: Members;
  readonly "~treq"?: ReqShape;
  readonly "~treqfn"?: ReqBehaviors;
  readonly "~tprops"?: PropsShape;
}

export type AnyTraitTyped = TraitTyped<any, any, any, any, any>;

type UnionToIntersection<U> = (U extends unknown ? (x: U) => void : never) extends (
  x: infer I,
) => void
  ? I
  : never;

/** Every entry a trait contributes is stamped with the TRAIT TYPE itself —
 * union commonality (§5.2) is decided by this stamp, mirroring the runtime's
 * trait-reference law. Model-own data has no stamp, so a name coincidence
 * never makes a member common. The stamp is an inert optional phantom. */
type StampTraitOrigin<T> = T extends TraitTyped<infer S, any, any, any, any>
  ? { [K in keyof S]: S[K] & { readonly "~originT"?: T } }
  : never;

export type TraitsShape<W extends readonly AnyTraitTyped[]> = [W[number]] extends [never]
  ? {}
  : UnionToIntersection<StampTraitOrigin<W[number]>> extends infer R
    ? R extends ShapeRecord
      ? R
      : {}
    : {};

export type TraitsMembers<W extends readonly AnyTraitTyped[]> = [W[number]] extends [never]
  ? {}
  : UnionToIntersection<
        W[number] extends TraitTyped<any, infer M, any, any, any> ? M : never
      > extends infer R
    ? R extends MembersRecord
      ? R
      : {}
    : {};

export type TraitsRequiredShape<W extends readonly AnyTraitTyped[]> = [W[number]] extends [never]
  ? {}
  : UnionToIntersection<
        W[number] extends TraitTyped<any, any, infer S, any, any> ? S : never
      > extends infer R
    ? R extends ShapeRecord
      ? R
      : {}
    : {};

export type TraitsRequiredBehaviors<W extends readonly AnyTraitTyped[]> = [W[number]] extends [never]
  ? {}
  : UnionToIntersection<
        W[number] extends TraitTyped<any, any, any, infer B, any> ? B : never
      > extends infer R
    ? R extends MembersRecord
      ? R
      : {}
    : {};

export type TraitsProps<W extends readonly AnyTraitTyped[]> = [W[number]] extends [never]
  ? {}
  : UnionToIntersection<
        W[number] extends TraitTyped<any, any, any, any, infer P> ? P : never
      > extends infer R
    ? R extends Record<string, unknown>
      ? R
      : {}
    : {};

/** `self` inside setup: fields + relations + trait members + required behaviors + API. */
export type SelfOf<
  Shape extends ShapeRecord,
  Members extends MembersRecord,
  Behaviors extends MembersRecord,
> = {
  readonly [K in keyof ConcreteKeys<Shape> & string]: SurfaceOfEntry<
    ConcreteKeys<Shape>[K],
    unknown
  >;
} & Readonly<ConcreteKeys<Members>> &
  Readonly<ConcreteKeys<Behaviors>> &
  InstanceApi;

/** Impl<typeof Trait>: the instance-side constraint for generic code (§4.4). */
export type Impl<T extends AnyTraitTyped> = T extends TraitTyped<
  infer Shape,
  infer Members,
  infer ReqShape,
  infer ReqB,
  any
>
  ? {
      readonly [K in keyof ConcreteKeys<Shape & ReqShape> & string]: SurfaceOfEntry<
        ConcreteKeys<Shape & ReqShape>[K],
        unknown
      >;
    } & Readonly<ConcreteKeys<Members>> &
      Readonly<ConcreteKeys<ReqB>>
  : never;

// --- unions (§5.2) -----------------------------------------------------------
// Variant identity is a model reference. The union type carries the variants
// tuple and whether a discriminator was declared; `add` exists only after
// `.by(...)`. Everything instance-facing distributes over the variants —
// non-distributive helpers over a union of shapes would collapse to the
// intersection of keys and lose per-variant members.

export interface UnionTyped<
  Vs extends readonly AnyModel[] = readonly AnyModel[],
  HasBy extends boolean = boolean,
> {
  readonly "~union": true;
  readonly "~variants"?: Vs;
  readonly "~hasBy"?: HasBy;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyUnionTyped = UnionTyped<any, any>;

type DistributeInstance<M> = M extends unknown ? InstanceOf<M> : never;
type DistributeDto<M> = M extends unknown ? Dto<M> : never;
type DistributeAddInput<M> = M extends unknown ? AddInput<M> : never;

type TraitOriginOf<E> = E extends { "~originT"?: infer O } ? Exclude<O, undefined> : never;

/** Distributive: every variant's entry must carry a stamp — one stampless
 * entry poisons the union with `false`. */
type EntryHasTraitOrigin<E> = E extends unknown
  ? [TraitOriginOf<E>] extends [never]
    ? false
    : true
  : never;

type EntryIsFieldDistrib<E> = E extends unknown
  ? E extends { kind: "field" }
    ? true
    : false
  : never;

/** All origins are ONE trait ⇔ their union collapses into their intersection. */
type SameTraitOrigin<E> = [TraitOriginOf<E>] extends [UnionToIntersection<TraitOriginOf<E>>]
  ? true
  : false;

/** Common members of a union (§5.2): keys every variant has, as a FIELD, from
 * the same trait by reference. `keyof` of a union of shapes intersects the key
 * sets; the stamp checks do the rest. */
export type UnionCommonShape<Vs extends readonly AnyModel[]> = IsAny<Vs[number]> extends true
  ? {}
  : [ShapeOf<Vs[number]>] extends [never]
    ? {}
    : {
        [K in keyof ShapeOf<Vs[number]> & string as [
          EntryIsFieldDistrib<ShapeOf<Vs[number]>[K]>,
        ] extends [true]
          ? [EntryHasTraitOrigin<ShapeOf<Vs[number]>[K]>] extends [true]
            ? SameTraitOrigin<ShapeOf<Vs[number]>[K]> extends true
              ? K
              : never
            : never
          : never]: ShapeOf<Vs[number]>[K];
      };

export type UnionDescriptors<Vs extends readonly AnyModel[]> = {
  readonly [K in keyof UnionCommonShape<Vs> & string]: FieldDescriptorTyped<
    FieldValueOf<UnionCommonShape<Vs>[K]>,
    FieldWireOf<UnionCommonShape<Vs>[K]>
  >;
};

export type TypedUnion<Vs extends readonly AnyModel[], HasBy extends boolean> = UnionTyped<
  Vs,
  HasBy
> & {
  readonly variants: Vs;
  by(discriminate: (json: DistributeDto<Vs[number]>) => Vs[number]): TypedUnion<Vs, true>;
} & UnionDescriptors<Vs>;

export interface TypedUnionQuery<Vs extends readonly AnyModel[]>
  extends Iterable<DistributeInstance<Vs[number]>> {
  readonly items: DistributeInstance<Vs[number]>[];
  readonly ids: string[];
  readonly count: number;
  readonly first: DistributeInstance<Vs[number]> | null;
  where(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    predicate: Predicate<any> | ((instance: DistributeInstance<Vs[number]>) => boolean),
  ): TypedUnionQuery<Vs>;
  sort(by: SortToken): TypedUnionQuery<Vs>;
  take(count: number): TypedUnionQuery<Vs>;
  /** Exhaustive by MODEL REFERENCES (§5.2): a missing variant fails to compile
   * (the error names it), each branch's callback sees ITS variant's
   * descriptors, and returns a predicate or a boolean literal. */
  match<const Ms extends readonly Vs[number][]>(
    ...branches: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      [I in keyof Ms]: readonly [Ms[I], (descriptors: Ms[I]) => Predicate<any> | boolean];
    } & ([Exclude<Vs[number], Ms[number]>] extends [never]
      ? unknown
      : readonly [missingVariants: Exclude<Vs[number], Ms[number]>])
  ): TypedUnionQuery<Vs>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  select<T>(descriptor: FieldDescriptorTyped<T, any>): T[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  set<T>(descriptor: FieldDescriptorTyped<T, any>, value: T): void;
  remove(id?: string): void;
  toArray(): DistributeInstance<Vs[number]>[];
}

export interface TypedUnionCollectionBase<Vs extends readonly AnyModel[]>
  extends TypedUnionQuery<Vs> {
  readonly variants: Vs;
  readonly scope: Scope;
  get(id: string): DistributeInstance<Vs[number]> | null;
}

interface TypedUnionAdd<Vs extends readonly AnyModel[]> {
  add(
    input: DistributeAddInput<Vs[number]>,
    options?: { replace?: boolean },
  ): DistributeInstance<Vs[number]>;
  add(
    input: readonly DistributeAddInput<Vs[number]>[],
    options?: { replace?: boolean },
  ): DistributeInstance<Vs[number]>[];
}

/** `add` exists only when the union declared a discriminator (§5.2). */
export type TypedUnionCollection<U> = IsAny<U> extends true
  ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
    any
  : U extends UnionTyped<infer Vs, infer HasBy>
    ? Vs extends readonly AnyModel[]
      ? [HasBy] extends [false]
        ? TypedUnionCollectionBase<Vs>
        : TypedUnionCollectionBase<Vs> & TypedUnionAdd<Vs>
      : UnionCollection
    : UnionCollection;

// Loose runtime surfaces — what the untyped `union()` overload works with.

export interface UnionQuery extends Iterable<object> {
  /** binding seams (§10.1) — same markers as model queries. */
  readonly "~query"?: true;
  readonly "~scope"?: Scope;
  readonly "~versions"?: () => unknown[];
  readonly items: object[];
  readonly ids: string[];
  readonly count: number;
  readonly first: object | null;
  where(predicate: { "~predicate": true } | ((instance: never) => boolean)): UnionQuery;
  sort(by: { "~sort": true }): UnionQuery;
  take(count: number): UnionQuery;
  match(
    ...branches: readonly (readonly [unknown, (descriptors: never) => unknown])[]
  ): UnionQuery;
  select(descriptor: { "~descriptor": true; field: string }): unknown[];
  set(descriptor: { "~descriptor": true; field: string }, value: unknown): void;
  remove(id?: string): void;
  toArray(): object[];
}

export interface UnionCollection extends UnionQuery {
  readonly "~unionCollection": true;
  readonly model: object;
  readonly scope: Scope;
  readonly variants: readonly ModelDefinition[];
  add(input: Record<string, unknown>, options?: { replace?: boolean }): object;
  add(input: readonly Record<string, unknown>[], options?: { replace?: boolean }): object[];
  get(id: string): object | null;
  remove(id?: string): void;
}
