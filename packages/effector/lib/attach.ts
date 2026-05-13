import { createEffect } from "./effect";
import { normalizeConfigMethod } from "./factory";
import { isEffect } from "./guards";
import { readSource } from "./shared";
import { getUnitDomain, type DomainLike } from "./domain-internal";
import type { Effect, EffectState, SourceShape, SourceValue } from "./types";

export function attach<Params, Done, Fail>(config: {
  effect: Effect<Params, Done, Fail>;
  name?: string;
  domain?: DomainLike;
}): Effect<Params, Done, Fail>;
export function attach<Params, Done, Fail = Error>(config: {
  effect(params: Params): Done | PromiseLike<Done>;
  name?: string;
  domain?: DomainLike;
}): Effect<Params, Done, Fail>;
export function attach<Params, Done, Fail, AttachedParams>(config: {
  effect: Effect<Params, Done, Fail>;
  mapParams(params: AttachedParams): Params;
  name?: string;
  domain?: DomainLike;
}): Effect<AttachedParams, Done, Fail>;
export function attach<Source extends SourceShape, Params, Done, Fail>(config: {
  source: Source;
  effect: Effect<Params, Done, Fail>;
  name?: string;
  domain?: DomainLike;
}): Effect<Params, Done, Fail>;
export function attach<Source extends SourceShape, Params, Done, Fail, AttachedParams>(config: {
  source: Source;
  effect: Effect<Params, Done, Fail>;
  mapParams(params: AttachedParams, source: SourceValue<Source>): Params;
  name?: string;
  domain?: DomainLike;
}): Effect<AttachedParams, Done, Fail>;
export function attach<Source extends SourceShape, Params, Done, Fail = Error>(config: {
  source: Source;
  effect(source: SourceValue<Source>, params: Params): Done | PromiseLike<Done>;
  name?: string;
  domain?: DomainLike;
}): Effect<Params, Done, Fail>;
export function attach(config: {
  source?: SourceShape;
  effect: Effect<any, any, any> | ((source: any, params: any) => any) | ((params: any) => any);
  mapParams?: (params: any, source?: any) => any;
  name?: string;
  sid?: string | null;
  domain?: DomainLike;
  and?: unknown;
  or?: unknown;
}): Effect<any, any, any> {
  const normalizedConfig = normalizeConfigMethod(config);
  const effectName = normalizedConfig.name ?? "attached";

  if (normalizedConfig.domain && isEffect(normalizedConfig.effect)) {
    throw new Error(
      `[attach] unit '${effectName}': \`domain\` can only be used with a plain function`,
    );
  }

  const domain = normalizedConfig.domain ?? getUnitDomain(normalizedConfig.effect);

  const attached = createEffect({
    name: effectName,
    sid: normalizedConfig.sid,
    domain,
    handler: (params: any) => {
      const hasSource = normalizedConfig.source !== undefined;
      const sourceValue = hasSource
        ? readSource(normalizedConfig.source as SourceShape)
        : undefined;

      if (isEffect(normalizedConfig.effect)) {
        const nextParams = normalizedConfig.mapParams
          ? normalizedConfig.mapParams(params, sourceValue)
          : hasSource
            ? sourceValue
            : params;

        return runAttachedEffect(normalizedConfig.effect as EffectState<any, any, any>, nextParams);
      }

      return hasSource
        ? (normalizedConfig.effect as (source: any, params: any) => any)(sourceValue, params)
        : (normalizedConfig.effect as (params: any) => any)(params);
    },
  });

  Object.defineProperty(attached, "__attached", {
    enumerable: false,
    value: true,
  });
  Object.defineProperty(attached, "__attachSource", {
    enumerable: false,
    value: normalizedConfig.source,
  });

  return attached;
}

function runAttachedEffect<Params, Done, Fail>(
  effect: EffectState<Params, Done, Fail>,
  params: Params,
): Done | PromiseLike<Done> {
  return effect(params);
}
