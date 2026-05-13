import * as core from "@virentia/core";
import type { EventPayload } from "@virentia/core";
import { createEvent, wrapEvent } from "./event";
import { normalizeUnitConfig } from "./factory";
import { sample } from "./operators";
import { attachUnitRegion, withRegion } from "./region";
import { callWithFallback, getName, getScopedEffectHandler, registerEffect } from "./shared";
import { createStoreFromBox, updateStoreFromDerived } from "./store";
import { registerDomainUnit, type DomainLike } from "./domain-internal";
import {
  unitKind,
  type Effect,
  type EffectState,
  type EventCallable,
  type Unsubscribe,
} from "./types";
import { watchUnit } from "./watch";

let nextEffectSid = 0;

interface EffectRunnerStep {
  type?: string;
  fn?: (payload: EffectRunnerPayload) => EffectRunnerPayload | void;
}

interface EffectRunnerPayload {
  params: unknown;
  handler?: (params: any) => unknown;
}

interface EffectRunnerNode {
  seq: EffectRunnerStep[];
}

interface EffectConfig<Params, Done> {
  name?: string;
  sid?: string | null;
  domain?: DomainLike;
  and?: unknown;
  handler?: (params: Params) => Done | PromiseLike<Done>;
}

export function createEffect<Params = void, Done = void, Fail = Error>(
  handlerOrConfig?:
    | string
    | ((params: Params) => Done | PromiseLike<Done>)
    | EffectConfig<Params, Done>,
  maybeConfig?: EffectConfig<Params, Done>,
): Effect<Params, Done, Fail> {
  const rawConfig =
    handlerOrConfig && typeof handlerOrConfig === "object"
      ? { ...normalizeUnitConfig(maybeConfig), ...handlerOrConfig }
      : maybeConfig;
  const config = normalizeUnitConfig(rawConfig);
  let handler = typeof handlerOrConfig === "function" ? handlerOrConfig : config?.handler;

  const effectName =
    typeof handlerOrConfig === "string" ? handlerOrConfig : getName(config ?? handlerOrConfig);
  const domain = config?.domain;

  if (domain) {
    return withRegion(domain.graphite, () => {
      const result = createEffect<Params, Done, Fail>(
        omitDomain(handlerOrConfig) as typeof handlerOrConfig,
        omitDomain(maybeConfig) as typeof maybeConfig,
      );

      overrideDomainEffectType(domain, result);
      registerDomainUnit(domain, "effect", result as any);
      return result;
    });
  }

  const sid =
    config && Object.hasOwn(config, "sid") ? config.sid : `virentia-effect-${++nextEffectSid}`;
  const runnerNode: EffectRunnerNode = {
    seq: [],
  };
  const fx = core.effect<Params, Done, Fail>((params) => {
    const payload = runEffectRunnerSteps(runnerNode, {
      params,
      handler,
    });
    const currentHandler = payload.handler as
      | ((params: Params) => Done | PromiseLike<Done>)
      | undefined;

    if (!currentHandler) {
      throw new Error(`no handler used in ${effectName === "unit" ? "effect" : effectName}`);
    }

    return currentHandler(payload.params as Params);
  });
  const started = core.event<Params>(effectName ? `${effectName}.started` : undefined);
  const done = core.event<{ params: Params; result: Done }>(
    effectName ? `${effectName}.done` : undefined,
  );
  const failed = core.event<{ params: Params; error: Fail }>(
    effectName ? `${effectName}.fail` : undefined,
  );
  const settled = core.event<
    | { status: "done"; params: Params; result: Done }
    | { status: "fail"; params: Params; error: Fail }
  >(effectName ? `${effectName}.finally` : undefined);
  const doneData = core.event<Done>(effectName ? `${effectName}.doneData` : undefined);
  const failData = core.event<Fail>(effectName ? `${effectName}.failData` : undefined);
  const inFlight = createStoreFromBox(
    core.store({ value: 0 }),
    wrapEvent<number>(core.event<number>(), `${effectName}.inFlight.updates`, {
      targetable: false,
    }),
    0,
    `${effectName}.inFlight`,
    undefined,
    { targetable: false, serialize: "ignore" },
  );
  const pending = createStoreFromBox(
    core.store({ value: false }),
    wrapEvent<boolean>(core.event<boolean>(), `${effectName}.pending.updates`, {
      targetable: false,
    }),
    false,
    `${effectName}.pending`,
    undefined,
    { targetable: false, serialize: "ignore" },
  );

  let result: EffectState<Params, Done, Fail>;

  result = callWithFallback(((...params: EventPayload<Params>) => {
    const runInScope = core.scoped();
    const payload = params[0] as Params;
    const runnerPayload = runEffectRunnerSteps(runnerNode, {
      params: payload,
      handler,
    });
    const currentHandler =
      getScopedEffectHandler(result) ??
      (runnerPayload.handler as ((params: Params) => Done | PromiseLike<Done>) | undefined);
    const nextInFlight = inFlight.getState() + 1;

    updateStoreFromDerived(inFlight, nextInFlight);
    updateStoreFromDerived(pending, nextInFlight > 0);

    void core.run({
      unit: started.node,
      payload,
    });

    if (!currentHandler) {
      const error = new Error(`no handler used in ${effectName === "unit" ? "effect" : effectName}`);

      emitFail(payload, error as Fail);
      return Promise.reject(error);
    }

    try {
      const handlerResult = currentHandler(runnerPayload.params as Params);

      if (isPromiseLike(handlerResult)) {
        return Promise.resolve(handlerResult).then(
          (value) => {
            runInScope(() => {
              emitDone(payload, value);
            });

            return value;
          },
          (error) => {
            runInScope(() => {
              emitFail(payload, error as Fail);
            });

            throw error;
          },
        );
      }

      emitDone(payload, handlerResult);
      return Promise.resolve(handlerResult);
    } catch (error) {
      emitFail(payload, error as Fail);
      return Promise.reject(error);
    }
  }) as EffectState<Params, Done, Fail>);

  Object.assign(result, {
    [unitKind]: "effect" as const,
    kind: "effect" as const,
    __core: fx,
    __started: started,
    node: fx.node,
    shortName: effectName,
    sid,
    targetable: true,
    compositeName: {
      shortName: effectName,
      fullName: effectName,
      path: [effectName],
    },
    getType: () => effectName,
    watch(fn: (payload: Params) => void): Unsubscribe {
      return watchUnit(wrapEvent(started), fn);
    },
    done: wrapEvent(done, "done", { targetable: false }),
    fail: wrapEvent(failed, "fail", { targetable: false }),
    finally: wrapEvent(settled, "finally", { targetable: false }),
    doneData: wrapEvent(doneData, "doneData", { targetable: false }),
    failData: wrapEvent(failData, "failData", { targetable: false }),
    pending,
    inFlight,
    map<Next>(fn: (payload: Params) => Next) {
      return wrapEvent(started.map(fn), `${effectName} → *`, { targetable: false });
    },
    filter(config: { fn(payload: Params): boolean } | ((payload: Params) => boolean)) {
      const fn = typeof config === "function" ? config : config.fn;
      return wrapEvent(started.filter(fn), `${effectName} → *`, { targetable: false });
    },
    filterMap<Next>(fn: (payload: Params) => Next | undefined) {
      return wrapEvent(started.filterMap(fn), `${effectName} → *`, { targetable: false });
    },
    prepend<Before>(fn: (payload: Before) => Params): EventCallable<Before> {
      const prepended = createEvent<Before>();

      sample({
        clock: prepended,
        fn,
        target: result,
      });

      return prepended;
    },
  });

  attachUnitRegion(result);
  (result as any).graphite.scope.runner = runnerNode;

  const use = ((nextHandler: (params: Params) => Done | PromiseLike<Done>) => {
    if (typeof nextHandler !== "function") {
      throw new Error(`[effect] unit '${effectName}': .use argument should be a function`);
    }

    handler = nextHandler;
    return result;
  }) as unknown as Effect<Params, Done, Fail>["use"];

  use.getCurrent = () => {
    if (!handler) {
      throw new Error(`no handler used in ${effectName === "unit" ? "effect" : effectName}`);
    }

    return handler;
  };

  result.use = use;
  registerEffect(result);
  registerDomainUnit(domain, "effect", result as any);

  return result;

  function emitDone(params: Params, value: Done): void {
    const finalOutcome = {
      status: "done" as const,
      params,
      result: value,
    };

    decrementInFlight();
    void core.run({ unit: done.node, payload: { params, result: value } });
    void core.run({ unit: doneData.node, payload: value });
    void core.run({ unit: settled.node, payload: finalOutcome });
  }

  function emitFail(params: Params, error: Fail): void {
    const finalOutcome = {
      status: "fail" as const,
      params,
      error,
    };

    decrementInFlight();
    void core.run({ unit: failed.node, payload: { params, error } });
    void core.run({ unit: failData.node, payload: error });
    void core.run({ unit: settled.node, payload: finalOutcome });
  }

  function decrementInFlight(): void {
    const nextInFlight = Math.max(0, inFlight.getState() - 1);

    updateStoreFromDerived(inFlight, nextInFlight);
    updateStoreFromDerived(pending, nextInFlight > 0);
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") && value !== null && "then" in value
  );
}

function runEffectRunnerSteps(
  runnerNode: EffectRunnerNode,
  initialPayload: EffectRunnerPayload,
): EffectRunnerPayload {
  let payload = initialPayload;

  for (const step of runnerNode.seq) {
    if (step.type !== "compute" || typeof step.fn !== "function") {
      continue;
    }

    payload = step.fn(payload) ?? payload;
  }

  return payload;
}

function omitDomain<T>(config: T): T {
  if (!config || typeof config !== "object") {
    return config;
  }

  const { domain: _domain, ...rest } = config as Record<string, unknown>;

  return rest as T;
}

function overrideDomainEffectType(domain: DomainLike, effect: Effect<any, any, any>): void {
  const fullName = joinName(domain.getType(), effect.shortName);

  Object.defineProperty(effect, "getType", {
    configurable: true,
    enumerable: true,
    value: () => fullName,
  });
  Object.defineProperty(effect, "compositeName", {
    configurable: true,
    enumerable: true,
    value: {
      shortName: effect.shortName,
      fullName,
      path: fullName.split("/").filter(Boolean),
    },
  });
}

function joinName(parentName: string, name: string): string {
  if (!parentName) {
    return name;
  }

  if (!name) {
    return parentName;
  }

  return `${parentName}/${name}`;
}
