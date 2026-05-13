import * as core from "@virentia/core";
import type { Scope as CoreScope } from "@virentia/core";
import type { DomainLike } from "./domain-internal";
import { isEffect, isEvent, isScopeError, isStore, isTargetable, isUnit } from "./guards";
import type {
  AnyUnit,
  CompatScope,
  Effect,
  EffectState,
  EventCallable,
  Scope,
  ScopeHandler,
  ScopeHandlers,
  SourceShape,
  Store,
  StoreValues,
  StoreWritable,
  UnitTarget,
} from "./types";

export const defaultScope = core.scope();
export const compatScopes = new WeakMap<CoreScope, CompatScope>();
export const storesBySid = new Map<string, StoreWritable<any>>();
export const effectsBySid = new Map<string, EffectState<any, any, any>>();
export const noSourceValue = Symbol("virentia.effector.noSourceValue");
let currentWatchScope: Scope | undefined;
let currentBoundScope: Scope | undefined;
export const nativeStoreKeys = new Set<PropertyKey>([
  "node",
  "writable",
  "subscribe",
  "map",
  "filter",
  "filterMap",
]);

const sourcePayloads = new WeakMap<object, { hasValue: boolean; value: unknown }>();
const trackedSources = new WeakSet<object>();
const scopeEffectHandlers = new WeakMap<Scope, WeakMap<EffectState<any, any, any>, core.EffectHandler<any, any>>>();

export function createCompatScope(scope: CoreScope, domain?: DomainLike): CompatScope {
  const existing = compatScopes.get(scope);

  if (existing) {
    if (domain && !existing.__domain) {
      Object.defineProperty(existing, "__domain", {
        configurable: true,
        enumerable: false,
        value: domain,
      });
    }

    return existing;
  }

  const compatScope = {
    __core: scope,
    __domain: domain,
    __changedSids: new Set<string>(),
    getState<T>(store: Store<T>): T {
      return store.getState(this);
    },
  };

  compatScopes.set(scope, compatScope);
  return compatScope;
}

export function getCurrentWatchScope(): Scope | undefined {
  return currentWatchScope;
}

export function getCurrentBoundScope(): Scope | undefined {
  return currentBoundScope;
}

export function getScopedEffectHandler(
  effect: EffectState<any, any, any>,
): core.EffectHandler<any, any> | undefined {
  const scope = getCurrentBoundScope();

  return scope ? scopeEffectHandlers.get(scope)?.get(effect) : undefined;
}

export function withCurrentWatchScope<T>(scope: CoreScope | null, fn: () => T): T {
  const previous = currentWatchScope;
  currentWatchScope = createCompatScope(scope ?? defaultScope);

  try {
    return fn();
  } finally {
    currentWatchScope = previous;
  }
}

export function withCurrentBoundScope<T>(scope: Scope, fn: () => T): T {
  const previous = currentBoundScope;
  currentBoundScope = scope;
  let result: T;

  try {
    result = fn();
  } catch (error) {
    currentBoundScope = previous;
    throw error;
  }

  if (isPromiseLike(result)) {
    return Promise.resolve(result).finally(() => {
      currentBoundScope = previous;
    }) as T;
  }

  currentBoundScope = previous;
  return result;
}

export function inScope<T>(scope: Scope | undefined, fn: () => T): T {
  if (scope) {
    return core.scoped(scope.__core, fn);
  }

  const boundScope = getCurrentBoundScope();

  if (boundScope) {
    return core.scoped(boundScope.__core, fn);
  }

  try {
    return fn();
  } catch (error) {
    if (!isScopeError(error)) {
      throw error;
    }

    return core.scoped(defaultScope, fn);
  }
}

export function callWithFallback<T extends (...args: any[]) => Promise<any>>(unit: T): T {
  return ((...args: Parameters<T>) => {
    const boundScope = getCurrentBoundScope();
    let result: ReturnType<T>;

    if (boundScope) {
      result = core.scoped(boundScope.__core, () => unit(...args)) as ReturnType<T>;
      markHandled(result);
      return result;
    }

    try {
      result = core.scoped(() => unit(...args)) as ReturnType<T>;
      markHandled(result);
      return result;
    } catch (error) {
      if (!isScopeError(error)) {
        throw error;
      }

      result = core.scoped(defaultScope, () => unit(...args)) as ReturnType<T>;
      markHandled(result);
      return result;
    }
  }) as T;
}

function markHandled(value: unknown): void {
  if (isPromiseLike(value) && typeof (value as Promise<unknown>).catch === "function") {
    void (value as Promise<unknown>).catch(noop);
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") && value !== null && "then" in value
  );
}

function noop(): void {}


export function readSource(source: unknown, scope?: Scope): unknown {
  if (isStore(source)) {
    return source.getState(scope);
  }

  if (isUnit(source)) {
    const state = sourcePayloads.get(source);

    return state?.hasValue ? state.value : noSourceValue;
  }

  if (Array.isArray(source)) {
    const values = source.map((item) => readSourceItem(item, scope));

    return values.includes(noSourceValue) ? noSourceValue : values;
  }

  if (source && typeof source === "object") {
    const entries = Object.entries(source).map(([key, item]) => [key, readSourceItem(item, scope)]);

    if (entries.some(([, value]) => value === noSourceValue)) {
      return noSourceValue;
    }

    return Object.fromEntries(entries);
  }

  return source;
}

export function sourceToClock(source: unknown): AnyUnit | AnyUnit[] {
  if (!source) {
    throw new Error("sample: clock or source is required");
  }

  if (isUnit(source)) {
    return source;
  }

  if (Array.isArray(source)) {
    return source.filter(isUnit);
  }

  if (typeof source === "object") {
    return Object.values(source).filter(isUnit);
  }

  throw new Error("sample: clock or source is required");
}

export function passesFilter(
  filter: Store<boolean> | ((source: any, clock: any) => boolean) | undefined,
  source: unknown,
  clock: unknown,
): boolean {
  if (!filter) {
    return true;
  }

  if (isStore(filter)) {
    return filter.getState();
  }

  return (filter as (source: unknown, clock: unknown) => boolean)(source, clock);
}

export function launchTarget(target: UnitTarget<any>, payload: unknown): void {
  for (const unit of toArray(target)) {
    assertTargetable(unit);

    if (isStore(unit)) {
      unit.setState(payload);
    } else {
      void (unit as EventCallable<unknown> | Effect<unknown, unknown>)(payload);
    }
  }
}

export function computeCombined(
  shape: unknown,
  fn?: (value: any) => any,
  spread = false,
  scope?: Scope,
): unknown {
  const value = readSource(shape, scope);

  if (!fn) {
    return value;
  }

  return spread && Array.isArray(value) ? (fn as (...args: any[]) => any)(...value) : fn(value);
}

export function trackSource(source: unknown): void {
  if (isStore(source)) {
    return;
  }

  if (isEvent(source) || isEffect(source)) {
    if (trackedSources.has(source)) {
      return;
    }

    trackedSources.add(source);
    sourcePayloads.set(source, { hasValue: false, value: undefined });
    source.watch((payload: unknown) => {
      sourcePayloads.set(source, { hasValue: true, value: payload });
    });
    return;
  }

  if (Array.isArray(source)) {
    for (const item of source) {
      trackSource(item);
    }

    return;
  }

  if (source && typeof source === "object") {
    for (const item of Object.values(source)) {
      trackSource(item);
    }
  }
}

export function assertTargetable(unit: unknown): void {
  if (!isTargetable(unit)) {
    throw new Error("unit should be targetable");
  }
}

export function registerStore(store: StoreWritable<any>): void {
  if (store.sid) {
    storesBySid.set(store.sid, store);
  }
}

export function registerEffect(effect: EffectState<any, any, any>): void {
  if (effect.sid) {
    effectsBySid.set(effect.sid, effect);
  }
}

export function applyScopeHandlers(scope: Scope, handlers: ScopeHandlers): void {
  if (Array.isArray(handlers)) {
    for (const [effect, handler] of handlers) {
      applyScopeHandler(scope, effect, handler);
    }

    return;
  }

  if (handlers instanceof Map) {
    for (const [effect, handler] of handlers) {
      applyScopeHandler(scope, effect, handler);
    }

    return;
  }

  for (const [sid, handler] of Object.entries(handlers)) {
    applyScopeHandler(scope, sid, handler);
  }
}

export function markScopeChanged(
  scope: CoreScope | null | undefined,
  sid: string | undefined,
): void {
  if (sid) {
    createCompatScope(scope ?? defaultScope).__changedSids.add(sid);
  }
}

export function applyStoreValues(scope: Scope, values: StoreValues): void {
  applyStoreValuesWithOptions(scope, values, { silent: false });
}

export function seedStoreValues(scope: Scope, values: StoreValues): void {
  applyStoreValuesWithOptions(scope, values, { silent: true });
}

function applyStoreValuesWithOptions(
  scope: Scope,
  values: StoreValues,
  options: { silent: boolean },
): void {
  if (Array.isArray(values)) {
    for (const [store, value] of values) {
      assertStoreValueKey(store);
      applyStoreValue(scope, store, value, options);
    }

    return;
  }

  if (values instanceof Map) {
    for (const [store, value] of values) {
      if (typeof store !== "string") {
        assertStoreValueKey(store);
      }
      applyStoreValue(scope, store, value, options);
    }

    return;
  }

  for (const [sid, value] of Object.entries(values)) {
    applyStoreValue(scope, sid, value, options);
  }
}

export function getName(input: unknown): string {
  if (typeof input === "string") {
    return input;
  }

  if (input && (typeof input === "object" || typeof input === "function") && "shortName" in input) {
    return String((input as { shortName?: string }).shortName ?? "unit");
  }

  if (input && (typeof input === "object" || typeof input === "function") && "name" in input) {
    return String((input as { name?: string }).name ?? "unit");
  }

  return "unit";
}

export function toArray<T>(value: T | readonly T[]): readonly T[] {
  return Array.isArray(value) ? (value as readonly T[]) : [value as T];
}

function readSourceItem(item: unknown, scope?: Scope): unknown {
  return isUnit(item) ? readSource(item, scope) : item;
}

function applyStoreValue(
  scope: Scope,
  storeOrSid: StoreWritable<any> | string,
  value: unknown,
  options: { silent: boolean },
): void {
  if (typeof storeOrSid === "string") {
    const store = storesBySid.get(storeOrSid);

    if (!store) {
      return;
    }

    const nextValue = typeof store.serialize === "object" ? store.serialize.read(value) : value;
    writeStoreValue(scope, store, nextValue, options);
    markScopeChanged(scope.__core, store.sid);
    return;
  }

  assertStoreValueKey(storeOrSid);
  writeStoreValue(scope, storeOrSid, value, options);
  markScopeChanged(scope.__core, storeOrSid.sid);
}

function writeStoreValue(
  scope: Scope,
  store: StoreWritable<any>,
  value: unknown,
  options: { silent: boolean },
): void {
  if (!options.silent) {
    store.setState(value, scope);
    return;
  }

  const box = Reflect.get(store, "__box") as core.StoreWritable<{ value: unknown }> | undefined;

  if (!box) {
    store.setState(value, scope);
    return;
  }

  core.seedScopeStoreValue(scope.__core, box, { value });
}

function applyScopeHandler(
  scope: Scope,
  effectOrSid: Effect<any, any, any> | string,
  handler: ScopeHandler,
): void {
  if (typeof effectOrSid !== "string" && !isUnit(effectOrSid)) {
    throw new Error("Map key should be a unit");
  }

  const effect =
    typeof effectOrSid === "string"
      ? effectsBySid.get(effectOrSid)
      : (effectOrSid as EffectState<any, any, any>);

  if (!effect) {
    return;
  }

  if (!isEffect(effect)) {
    throw new Error("Handlers map can contain only effects as keys");
  }

  const scopedHandler = createScopedEffectHandler(scope, effect, handler);
  const handlers = scopeEffectHandlers.get(scope) ?? new WeakMap();

  handlers.set(effect, scopedHandler);
  scopeEffectHandlers.set(scope, handlers);
  scope.__core.handlers.set(effect.__core, scopedHandler);
}

function assertStoreValueKey(value: unknown): asserts value is StoreWritable<any> {
  if (!isUnit(value)) {
    throw new Error("Map key should be a unit");
  }

  if (!isStore(value) || !isTargetable(value)) {
    throw new Error("Values map can contain only writable stores as keys");
  }
}

function createScopedEffectHandler(
  scope: Scope,
  effect: EffectState<any, any, any>,
  handler: ScopeHandler,
): core.EffectHandler<any, any> {
  return (params) => {
    const attachedSource = Reflect.get(effect, "__attachSource") as SourceShape | undefined;

    if (attachedSource !== undefined) {
      const sourceValue = readSource(attachedSource);

      if (isEffect(handler)) {
        return core.scoped(scope.__core, () =>
          (handler as EffectState<any, any, any>).use.getCurrent()(sourceValue),
        );
      }

      return (handler as (...params: any[]) => unknown)(sourceValue, params);
    }

    if (isEffect(handler)) {
      return core.scoped(scope.__core, () =>
        (handler as EffectState<any, any, any>).use.getCurrent()(params),
      );
    }

    return (handler as (...params: any[]) => unknown)(params);
  };
}
