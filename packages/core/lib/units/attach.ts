import { effect, runEffectHandler } from "./effect";
import type { Effect, EffectHandlerContext } from "./effect";
import { readStoreValue } from "./store";
import type { Store } from "./store";

export type AttachSourceShape = Store<any> | readonly Store<any>[] | Record<string, Store<any>>;

export type AttachSourceValue<Source> =
  Source extends Store<infer Value>
    ? Value
    : Source extends readonly unknown[]
      ? { readonly [Key in keyof Source]: Source[Key] extends Store<infer Value> ? Value : never }
      : Source extends Record<string, Store<any>>
        ? { [Key in keyof Source]: Source[Key] extends Store<infer Value> ? Value : never }
        : never;

type EffectHandlerWithSource<Source extends AttachSourceShape, Params, Done> = (
  source: AttachSourceValue<Source>,
  params: Params,
  ctx: EffectHandlerContext,
) => Done | PromiseLike<Done>;

export function attach<Params, Done, Fail>(config: {
  effect: Effect<Params, Done, Fail>;
}): Effect<Params, Done, Fail>;
export function attach<Params, Done, Fail = unknown>(config: {
  effect(params: Params, ctx: EffectHandlerContext): Done | PromiseLike<Done>;
}): Effect<Params, Done, Fail>;
export function attach<Params, Done, Fail, AttachedParams>(config: {
  effect: Effect<Params, Done, Fail>;
  mapParams(params: AttachedParams): Params;
}): Effect<AttachedParams, Done, Fail>;
export function attach<SourceValue, Params, Done, Fail, AttachedParams>(config: {
  source: Store<SourceValue>;
  effect: Effect<Params, Done, Fail>;
  mapParams(params: AttachedParams, source: SourceValue): Params;
}): Effect<AttachedParams, Done, Fail>;
export function attach<SourceValue, Params, Done, Fail = unknown>(config: {
  source: Store<SourceValue>;
  effect(source: SourceValue, params: Params, ctx: EffectHandlerContext): Done | PromiseLike<Done>;
}): Effect<Params, Done, Fail>;
export function attach<
  Source extends readonly Store<any>[],
  Params,
  Done,
  Fail,
  AttachedParams,
>(config: {
  source: Source;
  effect: Effect<Params, Done, Fail>;
  mapParams(params: AttachedParams, source: AttachSourceValue<Source>): Params;
}): Effect<AttachedParams, Done, Fail>;
export function attach<Source extends readonly Store<any>[], Params, Done, Fail = unknown>(config: {
  source: Source;
  effect(
    source: AttachSourceValue<Source>,
    params: Params,
    ctx: EffectHandlerContext,
  ): Done | PromiseLike<Done>;
}): Effect<Params, Done, Fail>;
export function attach<
  Source extends Record<string, Store<any>>,
  Params,
  Done,
  Fail,
  AttachedParams,
>(config: {
  source: Source;
  effect: Effect<Params, Done, Fail>;
  mapParams(params: AttachedParams, source: AttachSourceValue<Source>): Params;
}): Effect<AttachedParams, Done, Fail>;
export function attach<
  Source extends Record<string, Store<any>>,
  Params,
  Done,
  Fail = unknown,
>(config: {
  source: Source;
  effect(
    source: AttachSourceValue<Source>,
    params: Params,
    ctx: EffectHandlerContext,
  ): Done | PromiseLike<Done>;
}): Effect<Params, Done, Fail>;
export function attach<
  Source extends AttachSourceShape,
  Params,
  Done,
  Fail,
  AttachedParams,
>(config: {
  source: Source;
  effect: Effect<Params, Done, Fail>;
  mapParams(params: AttachedParams, source: AttachSourceValue<Source>): Params;
}): Effect<AttachedParams, Done, Fail>;
export function attach<Source extends AttachSourceShape, Params, Done, Fail = unknown>(config: {
  source: Source;
  effect: EffectHandlerWithSource<Source, Params, Done>;
}): Effect<Params, Done, Fail>;
export function attach(config: {
  source?: AttachSourceShape;
  effect:
    | Effect<any, any, any>
    | ((params: any, ctx: EffectHandlerContext) => any)
    | ((source: any, params: any, ctx: EffectHandlerContext) => any);
  mapParams?: (params: any, source?: any) => any;
}): Effect<any, any, any> {
  return effect((params: any, ctx: EffectHandlerContext) => {
    const hasSource = config.source !== undefined;
    const sourceValue = hasSource ? readSource(config.source as AttachSourceShape) : undefined;

    if (isEffect(config.effect)) {
      const nextParams = config.mapParams ? config.mapParams(params, sourceValue) : params;

      return runEffectHandler(config.effect, nextParams, ctx);
    }

    return hasSource
      ? (config.effect as (source: any, params: any, ctx: EffectHandlerContext) => any)(
          sourceValue,
          params,
          ctx,
        )
      : (config.effect as (params: any, ctx: EffectHandlerContext) => any)(params, ctx);
  });
}

function readSource(source: AttachSourceShape): unknown {
  if (isStore(source)) {
    return readStoreValue(source);
  }

  if (Array.isArray(source)) {
    return source.map((store) => readStoreValue(store));
  }

  return Object.fromEntries(
    Object.entries(source).map(([key, store]) => [key, readStoreValue(store)]),
  );
}

function isEffect(value: unknown): value is Effect<any, any, any> {
  return (
    typeof value === "function" && "doneData" in value && "failData" in value && "$pending" in value
  );
}

function isStore(value: unknown): value is Store<any> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    "node" in value &&
    "subscribe" in value
  );
}
