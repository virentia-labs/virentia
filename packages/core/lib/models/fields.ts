import { FormatRegistry, Kind, Type } from "@sinclair/typebox";
import type { Static, TSchema } from "@sinclair/typebox";

// TypeBox validates string formats only when they are registered; an unknown
// format fails the check outright. Register the ones f.* relies on (§4.8).
if (!FormatRegistry.Has("date-time")) {
  FormatRegistry.Set("date-time", (value) => !Number.isNaN(Date.parse(value)));
}

// A field is declared by a trait's (or model's) `data` and carries three
// independent concerns (§4.8): the VALUE schema (TypeBox — validation and
// Static<> come from there, not from us), the INPUT binding (which props key
// seeds the store and how it converts both ways), and STORE modifiers
// (index/unique/local). `f.*` are thin shortcuts over `Type.*` plus that layer.

export type IndexKind = "eq" | "ord";

export interface FieldBinding {
  /** Props key the store is bound to; `null` — bind by field name; `false` — local, off the wire. */
  key: string | null | false;
  in?: (wire: unknown) => unknown;
  out?: (value: unknown) => unknown;
  /** Explicitly one-way: json() omits the field without the dev diagnostic (§9.1). */
  inOnly?: boolean;
}

export type WireKeyType = string | null | false;

/** Structural value conversion (§4.8): composed RECURSIVELY by combinators —
 * `f.array(f.date())` maps every element, `f.object({...})` maps per key.
 * Identity codecs are never allocated, so plain shapes stay zero-overhead. A
 * top-level user `.map` takes over the whole conversion instead. */
export interface FieldCodec {
  in: (wire: unknown) => unknown;
  out: (value: unknown) => unknown;
}

export interface FieldDef<
  T = unknown,
  K extends WireKeyType = WireKeyType,
  Opt extends boolean = boolean,
  W = unknown,
> {
  readonly kind: "field";
  readonly schema: TSchema;
  /** Absent — the input key is required (§4.6: no default anywhere → required input). */
  readonly defaultValue?: { value: T };
  readonly binding: FieldBinding;
  readonly codec?: FieldCodec;
  readonly indexed?: IndexKind;
  readonly unique?: boolean;
  readonly optionalValue?: boolean;
  /** Phantoms: value, wire key, input optionality, wire value type. */
  readonly "~value"?: T;
  readonly "~key"?: K;
  readonly "~opt"?: Opt;
  readonly "~wireType"?: W;
}

// The effective boundary conversions. Precedence: a user binding transform
// (`.map` / props `.map`) REPLACES the field's structural codec — the user
// receives the raw wire value and owns both directions.
export function fieldIn(def: FieldDef, raw: unknown): unknown {
  if (def.binding.in) return def.binding.in(raw);
  if (def.codec && raw != null) return def.codec.in(raw);

  return raw;
}

export function fieldOut(def: FieldDef, value: unknown): unknown {
  if (def.binding.out) return def.binding.out(value);
  if (!def.binding.in && def.codec && value != null) return def.codec.out(value);

  return value;
}

/** True when the field converts on input but cannot serialize back (§9.1). */
export function fieldIsOneWay(def: FieldDef): boolean {
  return Boolean(def.binding.in) && !def.binding.out;
}

// A bound props source minted by the Props proxy in function-form `data`
// (§3.1/§9.1). It is a descriptor, not a value: the type deliberately exposes
// nothing value-like, so conditional logic over it does not typecheck.
// K — the wire key, Opt — the input key is optional, W — the wire (pre-parse)
// value type; all three feed Dto<> derivation (§9.1).
export interface Bound<T, K extends string = string, Opt extends boolean = boolean, W = T> {
  readonly "~bound": true;
  readonly "~key"?: K;
  readonly "~opt"?: Opt;
  readonly "~wire"?: W;
  readonly key: string;
  readonly in?: (wire: unknown) => unknown;
  readonly out?: (value: unknown) => unknown;
  readonly inOnly?: boolean;
  readonly fallback?: { value: T };
  map<Next>(parse: (wire: T) => Next, serialize?: (value: Next) => T): Bound<Next, K, Opt, W>;
  or(defaultValue: T): Bound<T, K, true, W>;
}

export type Props<Shape extends Record<string, unknown>> = {
  readonly [K in keyof Shape & string]-?: Bound<
    Exclude<Shape[K], undefined>,
    K,
    undefined extends Shape[K] ? true : false,
    Exclude<Shape[K], undefined>
  >;
};

const boundBrand = Symbol("virentia.models.bound");

export function isBound(value: unknown): value is Bound<unknown> {
  return typeof value === "object" && value !== null && boundBrand in (value as object);
}

function createBound<T>(
  key: string,
  extra: Partial<Pick<Bound<T>, "in" | "out" | "inOnly" | "fallback">> = {},
): Bound<T, any, any, any> {
  const self: Bound<T, any, any, any> = {
    [boundBrand]: true,
    "~bound": true,
    key,
    ...extra,

    map(parse, serialize) {
      return createBound(key, {
        ...extra,
        in: composeIn(extra.in, parse as (wire: unknown) => unknown),
        out: serialize
          ? composeOut(serialize as (value: unknown) => unknown, extra.out)
          : undefined,
        inOnly: extra.inOnly,
        // A fallback set before this map lives in the pre-parse space — convert it.
        fallback: extra.fallback
          ? { value: (parse as (wire: unknown) => unknown)(extra.fallback.value) }
          : undefined,
      });
    },

    or(defaultValue) {
      return createBound(key, { ...extra, fallback: { value: defaultValue } });
    },
  } as Bound<T, any, any, any> & { [boundBrand]: true };

  return self;
}

function composeIn(
  first: ((wire: unknown) => unknown) | undefined,
  second: (wire: unknown) => unknown,
): (wire: unknown) => unknown {
  return first ? (wire) => second(first(wire)) : second;
}

function composeOut(
  first: (value: unknown) => unknown,
  second: ((value: unknown) => unknown) | undefined,
): (value: unknown) => unknown {
  return second ? (value) => second(first(value)) : first;
}

/** The Props proxy handed to function-form `data`: every key access mints a Bound descriptor. */
export function createPropsProxy<Shape extends Record<string, unknown>>(): Props<Shape> {
  return new Proxy(Object.create(null) as Props<Shape>, {
    get(_target, property) {
      if (typeof property !== "string") return undefined;

      return createBound(property);
    },
  });
}

// ---------------------------------------------------------------------------
// Chainable field builder

interface FieldState<T, K extends WireKeyType, Opt extends boolean, W>
  extends Omit<FieldDef<T, K, Opt, W>, "~key" | "~opt" | "~wireType" | "indexed" | "unique"> {
  readonly "~key"?: K;
  readonly "~opt"?: Opt;
  readonly "~wireType"?: W;
  /** The canonical data record — methods below shadow same-named data keys. */
  readonly "~def": FieldDef<T, K, Opt, W>;
  or(defaultValue: T): Field<T, K, true, W>;
  optional(): Field<T | null, K, true, W | null>;
  map<Next = T>(parse: (wire: W) => Next, serialize?: (value: Next) => W): Field<Next, K, Opt, W>;
  inOnly(): Field<T, K, Opt, W>;
  local(): Field<T, false, Opt, W>;
  indexed(kind?: IndexKind): Field<T, K, Opt, W>;
  unique(): Field<T, K, Opt, W>;
  /** Format annotations merged into the TypeBox schema options — the channel
   * custom codecs (binary layouts etc.) read through reflection (§4.8). */
  meta(annotations: Record<string, unknown>): Field<T, K, Opt, W>;
}

export type Field<
  T,
  K extends WireKeyType = null,
  Opt extends boolean = false,
  W = T,
> = FieldState<T, K, Opt, W>;

export type AnyField = Field<any, any, any, any>;

function makeField<T>(partial: Omit<FieldDef<T>, "kind">): Field<T, any, any, any> {
  const def: FieldDef<T> = { kind: "field", ...partial };

  const chain = (patch: Partial<FieldDef<T>>): Field<T, any, any, any> =>
    makeField({ ...def, ...patch, binding: { ...def.binding, ...(patch.binding ?? {}) } });

  return {
    ...(def as unknown as Record<string, unknown>),
    // The clean data record: builder methods below SHADOW same-named data keys
    // (`indexed`, `unique`) on the wrapper, so consumers must read "~def".
    "~def": def,

    or(defaultValue: T) {
      return chain({ defaultValue: { value: defaultValue } });
    },

    inOnly() {
      return chain({ binding: { ...def.binding, inOnly: true } });
    },

    local() {
      return chain({ binding: { key: false } });
    },

    indexed(kind: IndexKind = "eq") {
      return chain({ indexed: kind });
    },

    unique() {
      return chain({ unique: true, indexed: def.indexed ?? "eq" });
    },

    meta(annotations: Record<string, unknown>) {
      return chain({ schema: { ...def.schema, ...annotations } as TSchema });
    },

    optional() {
      return chain({
        optionalValue: true,
        defaultValue: def.defaultValue ?? { value: null as T },
      }) as unknown as Field<T | null>;
    },

    map(parse: (wire: unknown) => unknown, serialize?: (value: unknown) => unknown) {
      return chain({
        binding: {
          ...def.binding,
          in: parse,
          out: serialize,
        },
      });
    },

  } as unknown as Field<T, any, any, any>;
}

// `f.X()` → required by-name input; `f.X(value)` → optional input with default
// (object-form rule, §3.1); `f.X(bound)` → store bound to that props source
// (function-form). The three call shapes share one factory. Overloads keep the
// wire key / optionality / wire type flowing into Dto<> (§9.1).
interface ScalarFactory<T, W = T> {
  (): Field<T, null, false, W>;
  (initial: T): Field<T, null, true, W>;
  <B extends Bound<T, any, any, any>>(
    bound: B,
  ): B extends Bound<T, infer K, infer Opt, infer BW> ? Field<T, K, Opt, BW> : never;
}

function scalar<T, W = T>(schema: TSchema, codec?: FieldCodec): ScalarFactory<T, W> {
  return ((...args: [initial?: T | Bound<T>]): Field<T, any, any, any> => {
    const [initial] = args;

    if (isBound(initial)) {
      const bound = initial as Bound<T>;

      return makeField<T>({
        schema,
        codec,
        defaultValue: bound.fallback as { value: T } | undefined,
        binding: {
          key: bound.key,
          in: bound.in,
          out: bound.out,
          inOnly: bound.inOnly,
        },
      });
    }

    return makeField<T>({
      schema,
      codec,
      defaultValue: args.length > 0 ? { value: initial as T } : undefined,
      binding: { key: null },
    });
  }) as ScalarFactory<T, W>;
}

const isoDate: FieldCodec = {
  in: (wire) => new Date(wire as string),
  out: (value) => (value as Date).toISOString(),
};

// ---------------------------------------------------------------------------
// Composition (§4.8): every combinator position takes a field OR a raw TypeBox
// schema, so any type assembles from `f.*` with `f.from`/plain `Type.*` as the
// leaves of last resort. Combinators compose CODECS along with schemas.

/** A combinator item: an `f.*` field or a raw TypeBox schema. */
export type FieldLike = AnyField | TSchema;

function isSchemaValue(value: unknown): value is TSchema {
  return typeof value === "object" && value !== null && Kind in (value as object);
}

function defOf(item: AnyField): FieldDef {
  return ((item as { "~def"?: FieldDef })["~def"] ?? item) as FieldDef;
}

function itemParts(item: FieldLike): { schema: TSchema; codec?: FieldCodec } {
  if (isFieldDef(item)) {
    const def = defOf(item as AnyField);

    return { schema: def.schema, codec: def.codec };
  }

  if (isSchemaValue(item)) return { schema: item };

  throw new Error("[models] a combinator item must be an f.* field or a TypeBox schema (§4.8)");
}

function assertNoItemCodecs(name: string, items: readonly FieldLike[]): void {
  for (const item of items) {
    if (itemParts(item).codec) {
      throw new Error(
        `[models] f.${name}: items with value transforms (f.date, .map) are not supported — the branch to convert cannot be decided; apply .map to the whole field instead (§4.8)`,
      );
    }
  }
}

function arrayCodec(item: FieldCodec): FieldCodec {
  return {
    in: (wire) => (wire as unknown[]).map((element) => (element == null ? element : item.in(element))),
    out: (value) => (value as unknown[]).map((element) => (element == null ? element : item.out(element))),
  };
}

function recordCodec(item: FieldCodec): FieldCodec {
  const map = (convert: (value: unknown) => unknown) => (input: unknown) =>
    Object.fromEntries(
      Object.entries(input as Record<string, unknown>).map(([key, element]) => [
        key,
        element == null ? element : convert(element),
      ]),
    );

  return { in: map(item.in), out: map(item.out) };
}

function shapeCodec(members: ReadonlyMap<string, FieldCodec>): FieldCodec {
  const map = (side: "in" | "out") => (input: unknown) => {
    const source = input as Record<string, unknown>;
    const result: Record<string, unknown> = { ...source };

    for (const [key, codec] of members) {
      if (source[key] != null) result[key] = codec[side](source[key]);
    }

    return result;
  };

  return { in: map("in"), out: map("out") };
}

function tupleCodec(items: readonly (FieldCodec | undefined)[]): FieldCodec {
  const map = (side: "in" | "out") => (input: unknown) =>
    (input as unknown[]).map((element, index) => {
      const codec = items[index];

      return codec && element != null ? codec[side](element) : element;
    });

  return { in: map("in"), out: map("out") };
}

/** Value/wire types of a combinator item — raw schemas contribute `Static<>`. */
export type ItemValue<I> = I extends Field<infer T, any, any, any>
  ? T
  : I extends TSchema
    ? Static<I>
    : never;

export type ItemWire<I> = I extends Field<any, any, any, infer W>
  ? W
  : I extends TSchema
    ? Static<I>
    : never;

type ShapeValues<S extends Record<string, FieldLike>> = { [K in keyof S]: ItemValue<S[K]> };
type ShapeWires<S extends Record<string, FieldLike>> = { [K in keyof S]: ItemWire<S[K]> };
type TupleValues<Items extends readonly FieldLike[]> = {
  -readonly [K in keyof Items]: ItemValue<Items[K]>;
};
type TupleWires<Items extends readonly FieldLike[]> = {
  -readonly [K in keyof Items]: ItemWire<Items[K]>;
};

/** The three call shapes every composite factory shares (§3.1). */
interface CompositeCalls<T, W> {
  (): Field<T, null, false, W>;
  (initial: T): Field<T, null, true, W>;
  <B extends Bound<any, any, any, any>>(
    bound: B,
  ): B extends Bound<any, infer K, infer Opt, infer BW> ? Field<T, K, Opt, BW> : never;
}

function composite<T>(
  schema: TSchema,
  codec: FieldCodec | undefined,
  args: readonly unknown[],
): Field<T, any, any, any> {
  const factory = scalar<T>(schema, codec) as (initial?: unknown) => Field<T, any, any, any>;

  return args.length > 0 ? factory(args[0]) : factory();
}

const arrayFactory = (<I extends FieldLike>(inner: I, ...args: unknown[]) => {
  const item = itemParts(inner);

  return composite(
    Type.Array(item.schema),
    item.codec ? arrayCodec(item.codec) : undefined,
    args,
  );
}) as {
  <I extends FieldLike>(inner: I): Field<ItemValue<I>[], null, false, ItemWire<I>[]>;
  <I extends FieldLike>(inner: I, initial: ItemValue<I>[]): Field<ItemValue<I>[], null, true, ItemWire<I>[]>;
  <I extends FieldLike, B extends Bound<any, any, any, any>>(
    inner: I,
    bound: B,
  ): B extends Bound<any, infer K, infer Opt, infer BW>
    ? Field<ItemValue<I>[], K, Opt, BW>
    : never;
};

export const f = {
  string: scalar<string>(Type.String()),
  number: scalar<number>(Type.Number()),
  integer: scalar<number>(Type.Integer()),
  boolean: scalar<boolean>(Type.Boolean()),
  null: scalar<null>(Type.Null()),
  any: scalar<any>(Type.Any()),
  unknown: scalar<unknown>(Type.Unknown()),

  /** Stored as Date; ISO string on the wire by default, overridable via `.map` (§4.8). */
  date: scalar<Date, string>(Type.String({ format: "date-time" }), isoDate),

  literal<T extends string | number | boolean>(value: T): Field<T, null, true, T> {
    return makeField<T>({
      schema: Type.Literal(value),
      defaultValue: { value },
      binding: { key: null },
    }) as Field<T, null, true, T>;
  },

  enum: (<T extends string | number>(values: readonly T[], ...args: unknown[]) => {
    const schema = Type.Union(values.map((value) => Type.Literal(value)));

    return composite<T>(schema, undefined, args);
  }) as {
    <T extends string | number>(values: readonly T[]): Field<T, null, false, T>;
    <T extends string | number>(values: readonly T[], initial: T): Field<T, null, true, T>;
    <T extends string | number, B extends Bound<T, any, any, any>>(
      values: readonly T[],
      bound: B,
    ): B extends Bound<T, infer K, infer Opt, infer W> ? Field<T, K, Opt, W> : never;
  },

  /** An ordered list of one item type; the item's conversions apply per element. */
  array: arrayFactory,
  /** Alias of `f.array`. */
  list: arrayFactory,

  /** A fixed-length tuple; each position keeps its own type and conversion. */
  tuple: (<const Items extends readonly FieldLike[]>(items: Items, ...args: unknown[]) => {
    const parts = items.map(itemParts);
    const hasCodec = parts.some((part) => part.codec);

    return composite(
      Type.Tuple(parts.map((part) => part.schema)),
      hasCodec ? tupleCodec(parts.map((part) => part.codec)) : undefined,
      args,
    );
  }) as {
    <const Items extends readonly FieldLike[]>(
      items: Items,
    ): Field<TupleValues<Items>, null, false, TupleWires<Items>>;
    <const Items extends readonly FieldLike[]>(
      items: Items,
      initial: TupleValues<Items>,
    ): Field<TupleValues<Items>, null, true, TupleWires<Items>>;
    <const Items extends readonly FieldLike[], B extends Bound<any, any, any, any>>(
      items: Items,
      bound: B,
    ): B extends Bound<any, infer K, infer Opt, infer BW>
      ? Field<TupleValues<Items>, K, Opt, BW>
      : never;
  },

  /** A value union. Variants with conversions are rejected — which branch to
   * convert cannot be decided; `.map` the whole field instead (§4.8). */
  union: (<const Items extends readonly FieldLike[]>(items: Items, ...args: unknown[]) => {
    assertNoItemCodecs("union", items);

    return composite(Type.Union(items.map((item) => itemParts(item).schema)), undefined, args);
  }) as {
    <const Items extends readonly FieldLike[]>(
      items: Items,
    ): Field<ItemValue<Items[number]>, null, false, ItemWire<Items[number]>>;
    <const Items extends readonly FieldLike[]>(
      items: Items,
      initial: ItemValue<Items[number]>,
    ): Field<ItemValue<Items[number]>, null, true, ItemWire<Items[number]>>;
    <const Items extends readonly FieldLike[], B extends Bound<any, any, any, any>>(
      items: Items,
      bound: B,
    ): B extends Bound<any, infer K, infer Opt, infer BW>
      ? Field<ItemValue<Items[number]>, K, Opt, BW>
      : never;
  },

  /** An intersection of schemas; same conversion restriction as `f.union`. */
  intersect: (<const Items extends readonly FieldLike[]>(items: Items, ...args: unknown[]) => {
    assertNoItemCodecs("intersect", items);

    return composite(Type.Intersect(items.map((item) => itemParts(item).schema)), undefined, args);
  }) as {
    <const Items extends readonly FieldLike[]>(
      items: Items,
    ): Field<UnionToIntersectionValue<ItemValue<Items[number]>>, null, false, UnionToIntersectionValue<ItemWire<Items[number]>>>;
    <const Items extends readonly FieldLike[]>(
      items: Items,
      initial: UnionToIntersectionValue<ItemValue<Items[number]>>,
    ): Field<UnionToIntersectionValue<ItemValue<Items[number]>>, null, true, UnionToIntersectionValue<ItemWire<Items[number]>>>;
  },

  /** A string-keyed map of one value type; conversions apply per entry. */
  record: (<I extends FieldLike>(inner: I, ...args: unknown[]) => {
    const item = itemParts(inner);

    return composite(
      Type.Record(Type.String(), item.schema),
      item.codec ? recordCodec(item.codec) : undefined,
      args,
    );
  }) as {
    <I extends FieldLike>(
      inner: I,
    ): Field<Record<string, ItemValue<I>>, null, false, Record<string, ItemWire<I>>>;
    <I extends FieldLike>(
      inner: I,
      initial: Record<string, ItemValue<I>>,
    ): Field<Record<string, ItemValue<I>>, null, true, Record<string, ItemWire<I>>>;
    <I extends FieldLike, B extends Bound<any, any, any, any>>(
      inner: I,
      bound: B,
    ): B extends Bound<any, infer K, infer Opt, infer BW>
      ? Field<Record<string, ItemValue<I>>, K, Opt, BW>
      : never;
  },

  /** A nested object from a shape of fields (per-key conversions apply), or
   * from a ready-made TypeBox object schema. */
  object: (<S extends Record<string, FieldLike>>(shape: S | TSchema, ...args: unknown[]) => {
    if (isSchemaValue(shape)) {
      return composite(shape, undefined, args);
    }

    const members = new Map<string, FieldCodec>();
    const properties: Record<string, TSchema> = {};

    for (const [key, item] of Object.entries(shape)) {
      const part = itemParts(item);

      properties[key] = part.schema;

      if (part.codec) members.set(key, part.codec);
    }

    return composite(
      Type.Object(properties),
      members.size > 0 ? shapeCodec(members) : undefined,
      args,
    );
  }) as {
    <S extends Record<string, FieldLike>>(
      shape: S,
    ): Field<ShapeValues<S>, null, false, ShapeWires<S>>;
    <S extends Record<string, FieldLike>>(
      shape: S,
      initial: ShapeValues<S>,
    ): Field<ShapeValues<S>, null, true, ShapeWires<S>>;
    <T extends Record<string, unknown>>(schema: TSchema): Field<T, null, false, T>;
    <T extends Record<string, unknown>>(schema: TSchema, initial: T): Field<T, null, true, T>;
  },

  /** A self-referential schema (trees in one value). The body sees `self` as an
   * item; conversions inside a recursive body are rejected for now (§4.8). */
  recursive: (<T>(build: (self: TSchema) => FieldLike, ...args: unknown[]) => {
    let sawCodec = false;
    const schema = Type.Recursive((self) => {
      const part = itemParts(build(self));

      sawCodec ||= Boolean(part.codec);

      return part.schema as never;
    });

    if (sawCodec) {
      throw new Error(
        "[models] f.recursive: value transforms inside a recursive body are not supported — apply .map to the whole field instead (§4.8)",
      );
    }

    return composite<T>(schema, undefined, args);
  }) as {
    <T>(build: (self: TSchema) => FieldLike): Field<T, null, false, T>;
    <T>(build: (self: TSchema) => FieldLike, initial: T): Field<T, null, true, T>;
  },

  /** Any ready-made TSchema — complex values are written in plain TypeBox (§4.8). */
  from: (<T>(schema: TSchema, ...args: unknown[]) => composite<T>(schema, undefined, args)) as {
    <T>(schema: TSchema): Field<T, null, false, T>;
    <T>(schema: TSchema, initial: T): Field<T, null, true, T>;
    <T, B extends Bound<T, any, any, any>>(
      schema: TSchema,
      bound: B,
    ): B extends Bound<T, infer K, infer Opt, infer W> ? Field<T, K, Opt, W> : never;
  },

  /** Generic placeholder — `Type.Argument`, instantiated at trait application (§4.5). */
  arg(index: number): Field<unknown> {
    return makeField<unknown>({
      schema: Type.Argument(index),
      binding: { key: null },
    });
  },
};

type UnionToIntersectionValue<U> = (U extends unknown ? (x: U) => void : never) extends (
  x: infer I,
) => void
  ? I
  : never;

/** Behavior requirement inside `requires` (§4.1): a signature, never storage. */
export interface FnRequirement<T extends (...args: never[]) => unknown = (...args: never[]) => unknown> {
  readonly kind: "fn";
  readonly "~signature"?: T;
}

export function fn<T extends (...args: never[]) => unknown>(): FnRequirement<T> {
  return { kind: "fn" };
}

export function isFieldDef(value: unknown): value is FieldDef {
  return typeof value === "object" && value !== null && (value as FieldDef).kind === "field";
}

export function isFnRequirement(value: unknown): value is FnRequirement {
  return typeof value === "object" && value !== null && (value as FnRequirement).kind === "fn";
}
