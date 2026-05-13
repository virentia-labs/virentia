import * as core from "@virentia/core";
import { createEvent, wrapEvent } from "./event";
import { normalizeUnitConfig, unpackConfigMethodArgs } from "./factory";
import { isEffect, isStore, isUnit } from "./guards";
import { getUnitDomain } from "./domain-internal";
import {
  assertTargetable,
  computeCombined,
  defaultScope,
  launchTarget,
  noSourceValue,
  readSource,
  sourceToClock,
  trackSource,
  toArray,
} from "./shared";
import { createStore, createStoreFromBox } from "./store";
import type {
  AnyUnit,
  Effect,
  Event,
  EventCallable,
  SourceShape,
  Store,
  StoreWritable,
  Unit,
  UnitTarget,
} from "./types";

interface SampleConfig {
  clock?: AnyUnit | readonly AnyUnit[];
  source?: unknown;
  filter?: Store<boolean> | ((source: any, clock: any) => boolean);
  fn?: (source: any, clock: any) => any;
  target?: UnitTarget<any>;
  sid?: string;
  name?: string;
  batch?: boolean;
  greedy?: boolean;
}

interface CombineConfig {
  name?: string;
  sid?: string | null;
  skipVoid?: boolean;
  and?: unknown;
}

export function sample(config: SampleConfig): AnyUnit;
export function sample(source: unknown): AnyUnit;
export function sample(source: unknown, clock: AnyUnit | readonly AnyUnit[]): AnyUnit;
export function sample(
  source: unknown,
  clock: AnyUnit | readonly AnyUnit[],
  fn: (source: any, clock: any) => any,
): AnyUnit;
export function sample(...args: any[]): AnyUnit {
  const unpacked = unpackConfigMethodArgs(args);
  const config = normalizeSampleArgs(unpacked.args);

  if (unpacked.config) {
    config.name ??= unpacked.config.name;
    config.sid ??= unpacked.config.sid ?? undefined;
  }
  const hasSource = Object.hasOwn(config, "source");
  const hasClock = Object.hasOwn(config, "clock");

  if (hasSource && config.source === undefined) {
    throw new Error("source should be defined");
  }

  if (hasClock && config.clock === undefined) {
    throw new Error("clock should be defined");
  }

  if (!hasSource && !hasClock) {
    throw new Error("either source or clock should be defined");
  }

  if (config.target) {
    for (const target of toArray(config.target)) {
      assertTargetable(target);
    }
  }

  if (config.greedy !== undefined) {
    console.error("[sample] greedy in sample is deprecated, use batch instead");
  }

  if (hasSource) {
    trackSource(config.source);
  }

  const target = config.target ?? createSampleTarget(config);
  const ownsTarget = !config.target;
  const clocks = toArray(hasClock ? config.clock : sourceToClock(config.source)) as AnyUnit[];

  for (const clock of clocks) {
    core.reaction({
      on: sampleClock(clock) as any,
      run: (clockPayload: unknown) => {
        const normalizedClockPayload = normalizeSampleClockPayload(clockPayload);
        let sourceValue = hasSource ? readSource(config.source) : undefined;

        if (
          sourceValue === noSourceValue &&
          !hasClock &&
          isEffect(config.source) &&
          clock === config.source
        ) {
          sourceValue = normalizedClockPayload;
        }

        if (sourceValue === noSourceValue) {
          return;
        }

        if (!passesSampleFilter(config.filter, sourceValue, normalizedClockPayload, hasSource)) {
          return;
        }

        const payload = config.fn
          ? !hasSource
            ? config.fn(normalizedClockPayload, normalizedClockPayload)
            : config.fn(sourceValue, normalizedClockPayload)
          : !hasSource
            ? normalizedClockPayload
            : sourceValue;

        if (ownsTarget) {
          emitDerivedTarget(target, payload);
        } else {
          launchTarget(target, payload);
        }
      },
    });
  }

  return (Array.isArray(target) ? target[0] : target) as AnyUnit;
}

function sampleClock(clock: AnyUnit): AnyUnit | core.Event<any> {
  return isEffect(clock) ? ((clock as any).__started ?? (clock as any).__core.started) : clock;
}

function normalizeSampleClockPayload(payload: unknown): unknown {
  return isCoreEffectCallState(payload) ? payload.params : payload;
}

function isCoreEffectCallState(value: unknown): value is { params: unknown } {
  return Boolean(
    value &&
      typeof value === "object" &&
      "params" in value &&
      "controller" in value &&
      "cleanup" in value,
  );
}

export function combine(shape: SourceShape, fn?: (value: any) => any): Store<any>;
export function combine(...args: any[]): Store<any>;
export function combine(...args: any[]): Store<any> {
  const unpacked = unpackConfigMethodArgs(args);
  args = unpacked.args;
  const trailingConfig = extractTrailingCombineConfig(args);
  const combineConfig = {
    ...unpacked.config,
    ...normalizeUnitConfig(trailingConfig),
  };

  if (args.length === 0) {
    throw new Error("expect first argument be an object");
  }

  const fn = typeof args[args.length - 1] === "function" ? args.pop() : undefined;

  if (args.length === 0) {
    throw new Error("expect first argument be an object");
  }

  validateCombineArgs(args, Boolean(fn), combineConfig.name);

  const singleUnitWithFn = Boolean(fn) && args.length === 1 && isUnit(args[0]);
  const spread = args.length > 1;
  const shape = singleUnitWithFn
    ? args[0]
    : spread
      ? args
      : Array.isArray(args[0]) || isPlainShape(args[0])
        ? args[0]
        : args;
  const initial = computeCombined(shape, fn, spread);
  const name = combineConfig.name ?? "combine";
  const box = core.store({ value: initial });
  let currentValue = initial;

  warnInitialSkipVoid(initial, name, combineConfig.skipVoid);

  const result = createStoreFromBox(
    box,
    wrapEvent(core.event<any>(), "combine updates", { targetable: false }),
    initial,
    name,
    combineConfig.sid ?? undefined,
    {
      targetable: false,
      skipVoid: combineConfig.skipVoid,
      read: (scope) => computeCombined(shape, fn, spread, scope),
    },
  );

  core.scoped(defaultScope, () => {
    core.reaction(() => {
      const next = computeCombined(shape, fn, spread);

      if (next === undefined && combineConfig.skipVoid !== false) {
        if (combineConfig.skipVoid !== true) {
          warnCombineSkipVoid(name);
        }

        return;
      }

      if (Object.is(currentValue, next)) {
        return;
      }

      currentValue = next;
      (result as any).__box.value = next;
    });
  });

  return result;
}

function extractTrailingCombineConfig(args: any[]): CombineConfig | undefined {
  const last = args.at(-1);

  if (
    args.length >= 2 &&
    last &&
    typeof last === "object" &&
    !Array.isArray(last) &&
    !isUnit(last) &&
    (Object.hasOwn(last, "skipVoid") ||
      Object.hasOwn(last, "name") ||
      Object.hasOwn(last, "sid") ||
      Object.hasOwn(last, "and"))
  ) {
    return args.pop();
  }

  return undefined;
}

function warnInitialSkipVoid(value: unknown, name: string, skipVoid: boolean | undefined): void {
  if (skipVoid === true) {
    console.error(
      `[store] unit '${name}': {skipVoid: true} is deprecated, use updateFilter instead`,
    );
    return;
  }

  if (value === undefined && skipVoid !== false) {
    console.error(
      `[combine] unit '${name}': undefined is used to skip updates. To allow undefined as a value provide explicit { skipVoid: false } option`,
    );
  }
}

function warnCombineSkipVoid(name: string): void {
  console.error(
    `[combine] unit '${name}': undefined is used to skip updates. To allow undefined as a value provide explicit { skipVoid: false } option`,
  );
}

export function guard(configOrSource: any, maybeConfig?: any): AnyUnit {
  const unpacked = unpackConfigMethodArgs(
    arguments.length > 1 ? [configOrSource, maybeConfig] : [configOrSource],
  );
  configOrSource = unpacked.args[0];
  maybeConfig = unpacked.args[1];
  const config = maybeConfig ? { ...maybeConfig, source: configOrSource } : configOrSource;

  if (unpacked.config) {
    config.name ??= unpacked.config.name;
    config.sid ??= unpacked.config.sid ?? undefined;
  }

  if (!config || typeof config !== "object") {
    throw new Error("guard expects config");
  }

  const hasSource = Object.hasOwn(config, "source");
  const hasClock = Object.hasOwn(config, "clock");

  if (hasSource && config.source === undefined) {
    throw new Error("source should be defined");
  }

  if (hasClock && config.clock === undefined) {
    throw new Error("clock should be defined");
  }

  if (!hasSource && !hasClock) {
    throw new Error("either source or clock should be defined");
  }

  return sample({
    ...config,
    filter: config.filter,
  });
}

export function forward(config: {
  from: AnyUnit | readonly AnyUnit[];
  to: UnitTarget<any>;
}): () => void {
  config = unpackConfigMethodArgs([config]).args[0];

  for (const target of toArray(config.to)) {
    assertTargetable(target);
  }

  const unsubs = toArray(config.from).map((unit) => {
    const source = isStore(unit) ? unit.updates : sampleClock(unit);
    const subscription = core.reaction({
      on: source as any,
      run: (payload: unknown) => {
        launchTarget(config.to, payload);
      },
    });

    return () => {
      subscription.stop();
    };
  });

  return () => {
    for (const unsubscribe of unsubs) {
      unsubscribe();
    }
  };
}

export function launch(config: {
  target: UnitTarget<any>;
  params?: unknown;
  defer?: boolean;
}): void {
  launchTarget(config.target, config.params);
}

export function merge(units: readonly AnyUnit[]): EventCallable<any> {
  const target = wrapEvent<any>(core.event<any>(), "merge", { targetable: false });

  for (const unit of units) {
    core.reaction({
      on: sampleClock(unit) as any,
      run: (payload: unknown) => {
        void core.run({ unit: (target as any).__core.node, payload });
      },
    });
  }

  return target;
}

export function split<T>(
  source: Unit<T>,
  cases: Record<string, (payload: T) => boolean>,
): Record<string, Event<T>>;
export function split<T>(config: {
  source: Unit<T>;
  match: ((payload: T) => string) | Record<string, (payload: T) => boolean>;
  cases?: Record<string, Event<T>>;
}): Record<string, Event<T>>;
export function split<T>(
  sourceOrConfig:
    | Unit<T>
    | {
        source: Unit<T>;
        clock?: Unit<any>;
        match: ((payload: T) => string) | Record<string, (payload: T) => boolean>;
        cases?: Record<string, Event<T>>;
        target?: Record<string, UnitTarget<T>>;
      },
  maybeCases?: Record<string, (payload: T) => boolean>,
): Record<string, Event<T>> {
  const unpacked = unpackConfigMethodArgs(
    maybeCases === undefined ? [sourceOrConfig] : [sourceOrConfig, maybeCases],
  );
  sourceOrConfig = unpacked.args[0] as typeof sourceOrConfig;
  maybeCases = unpacked.args[1];

  const source = "source" in sourceOrConfig ? sourceOrConfig.source : sourceOrConfig;
  const clock = "source" in sourceOrConfig ? sourceOrConfig.clock : undefined;
  const match = "source" in sourceOrConfig ? sourceOrConfig.match : (maybeCases ?? {});
  const result: Record<string, UnitTarget<T>> = {};
  const configuredCases =
    "source" in sourceOrConfig ? (sourceOrConfig.cases ?? sourceOrConfig.target ?? {}) : {};

  if (!isUnit(source)) {
    throw new Error("source must be a unit");
  }

  if (clock && !isUnit(clock)) {
    throw new Error("clock must be a unit");
  }

  for (const target of Object.values(configuredCases)) {
    for (const unit of toArray(target as UnitTarget<T>)) {
      assertTargetable(unit);
    }
  }

  if (isStore(match)) {
    for (const key of Object.keys(configuredCases)) {
      result[key] =
        (configuredCases[key] as UnitTarget<T>) ??
        wrapEvent<T>(core.event<T>(), `cases.${key}`, { targetable: false });
    }
  } else if (typeof match === "function") {
    for (const key of Object.keys(configuredCases)) {
      result[key] =
        (configuredCases[key] as UnitTarget<T>) ??
        wrapEvent<T>(core.event<T>(), `cases.${key}`, { targetable: false });
    }
  } else {
    for (const key of Object.keys(match)) {
      result[key] =
        (configuredCases[key] as UnitTarget<T>) ??
        wrapEvent<T>(core.event<T>(), `cases.${key}`, { targetable: false });
    }
  }

  result.__ =
    (configuredCases.__ as UnitTarget<T> | undefined) ??
    wrapEvent<T>(core.event<T>(), "__", { targetable: false });

  if (clock) {
    trackSource(source);
  }

  core.reaction({
    on: (clock ? sampleClock(clock) : sampleClock(source)) as any,
    run: (clockPayload: T) => {
      const payload = (clock ? readSource(source) : clockPayload) as T;

      if (payload === noSourceValue) {
        return;
      }

      const key = resolveSplitKey(match, payload);

      emitSplitTarget(result[key ?? "__"] ?? result.__, payload);
    },
  });

  return result as Record<string, Event<T>>;
}

function resolveSplitKey<T>(
  match:
    | Store<string>
    | ((payload: T) => string)
    | Record<string, Store<boolean> | ((payload: T) => boolean)>,
  payload: T,
): string | undefined {
  if (isStore(match)) {
    return match.getState();
  }

  if (typeof match === "function") {
    return match(payload);
  }

  const matchers = match as Record<string, Store<boolean> | ((payload: T) => boolean)>;

  return Object.keys(matchers).find((caseName) => {
    const matcher = matchers[caseName];

    return isStore(matcher) ? matcher.getState() : (matcher as (payload: T) => boolean)(payload);
  });
}

export function createApi<T, Shape extends Record<string, (state: T, payload: any) => T>>(
  store: StoreWritable<T>,
  reducers: Shape,
): {
  [Key in keyof Shape]: EventCallable<Parameters<Shape[Key]>[1]>;
} {
  const unpacked = unpackConfigMethodArgs([store, reducers]);
  store = unpacked.args[0];
  reducers = unpacked.args[1];
  const result = {} as {
    [Key in keyof Shape]: EventCallable<Parameters<Shape[Key]>[1]>;
  };

  for (const key of Object.keys(reducers) as Array<keyof Shape>) {
    const event = createEvent<Parameters<Shape[typeof key]>[1]>({
      name: String(key),
      domain: getUnitDomain(store),
    });
    store.on(event, reducers[key]);
    result[key] = event;
  }

  return result;
}

export function restore<T>(unit: Event<T> | Effect<any, T, any>, defaultState: T): StoreWritable<T>;
export function restore<Shape extends readonly unknown[]>(
  shape: Shape,
): {
  [Key in keyof Shape]: StoreWritable<Shape[Key]>;
};
export function restore<Shape extends Record<string, unknown>>(
  shape: Shape,
): {
  [Key in keyof Shape]: StoreWritable<Shape[Key]>;
};
export function restore(unit: any, defaultState?: any): any {
  const unpacked = unpackConfigMethodArgs(Array.from(arguments));
  unit = unpacked.args[0];
  defaultState = unpacked.args[1];
  const restoreConfig = {
    ...unpacked.config,
    ...normalizeUnitConfig(unpacked.args[2]),
  };

  if (Array.isArray(unit)) {
    return unit.map((value) => createStore(value));
  }

  if (!isUnit(unit) && unit && typeof unit === "object") {
    return Object.fromEntries(
      Object.entries(unit).map(([key, value]) => [key, createStore(value)]),
    );
  }

  const store = createStore(defaultState, {
    name: restoreConfig.name,
    sid: restoreConfig.sid ?? undefined,
    domain: getUnitDomain(unit),
  });
  const source = isEffect(unit) ? unit.doneData : unit;

  store.on(source, (_, payload) => payload);

  return store;
}

function normalizeSampleArgs(args: any[]): SampleConfig {
  if (args.length === 1) {
    const first = args[0];

    if (isSampleConfig(first)) {
      return first;
    }

    return { source: first };
  }

  if (args.length === 2) {
    assertValidPositionalSource(args[0]);
    return { source: args[0], clock: args[1] };
  }

  assertValidPositionalSource(args[0]);
  return { source: args[0], clock: args[1], fn: args[2] };
}

function isSampleConfig(value: unknown): value is SampleConfig {
  if (!value || typeof value !== "object" || isUnit(value) || Array.isArray(value)) {
    return false;
  }

  return ["source", "clock", "filter", "fn", "target", "sid", "name", "batch", "greedy"].some(
    (key) => Object.hasOwn(value, key),
  );
}

function createSampleTarget(config: SampleConfig): AnyUnit {
  const hasClock = Object.hasOwn(config, "clock");
  const clock = config.clock;
  const source = config.source;
  const storeResult =
    isStore(source) &&
    !config.filter &&
    (!hasClock || (isStore(clock) && !Array.isArray(clock)));

  if (storeResult) {
    const initialClock = isStore(clock) ? clock.getState() : readSource(source);
    const initialSource = readSource(source);
    const initial = config.fn ? config.fn(initialSource, initialClock) : initialSource;

    return createStoreFromBox(
      core.store({ value: initial }),
      wrapEvent(core.event<any>(), `${config.name ?? "sample"} updates`, { targetable: false }),
      initial,
      config.name ?? "sample",
      config.sid,
      { targetable: false },
    );
  }

  const target = wrapEvent<any>(core.event<any>(), config.name ?? "sample", {
    targetable: false,
  });

  if (config.sid) {
    Object.defineProperty(target, "sid", {
      configurable: true,
      enumerable: true,
      value: config.sid,
    });
  }

  return target;
}

function passesSampleFilter(
  filter: Store<boolean> | ((source: any, clock: any) => boolean) | undefined,
  source: unknown,
  clock: unknown,
  hasSource: boolean,
): boolean {
  if (!filter) {
    return true;
  }

  if (isStore(filter)) {
    return filter.getState();
  }

  return hasSource
    ? (filter as (source: unknown, clock: unknown) => boolean)(source, clock)
    : (filter as (clock: unknown) => boolean)(clock);
}

function emitDerivedTarget(target: UnitTarget<any>, payload: unknown): void {
  for (const unit of toArray(target)) {
    if (isStore(unit)) {
      (unit as any).__box.value = payload;
      continue;
    }

    void core.run({
      unit: (unit as any).__core.node,
      payload,
    });
  }
}

function emitSplitTarget(target: UnitTarget<any>, payload: unknown): void {
  for (const unit of toArray(target)) {
    if (unit.targetable) {
      launchTarget(unit, payload);
      continue;
    }

    void core.run({
      unit: (unit as any).__core.node,
      payload,
    });
  }
}

function isPlainShape(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && !isUnit(value));
}

function assertValidPositionalSource(source: unknown): void {
  if (!isUnit(source) && !Array.isArray(source) && (!source || typeof source !== "object")) {
    throw new Error("expect first argument be an object");
  }
}

function validateCombineArgs(args: any[], hasFn: boolean, name = "combine"): void {
  if (args.length === 1) {
    const shape = args[0];

    if (shape === null || shape === undefined) {
      throw new Error(`[combine] unit '${name}': shape should be an object`);
    }

    if (!isUnit(shape) && typeof shape !== "object") {
      throw new Error(`[combine] unit '${name}': shape should be an object`);
    }

    if (isPlainShape(shape) && !Array.isArray(shape)) {
      for (const [key, value] of Object.entries(shape)) {
        if (
          value === undefined ||
          (isUnit(value) && !isStore(value)) ||
          (value && typeof value === "object" && "__domainState" in value)
        ) {
          throw new Error(`[combine] unit '${name}': combine expects a store in a field ${key}`);
        }
      }
    }

    return;
  }

  if (hasFn && args.length === 1 && !isUnit(args[0]) && !Array.isArray(args[0])) {
    throw new Error(`[combine] unit '${name}': shape should be an object`);
  }
}
