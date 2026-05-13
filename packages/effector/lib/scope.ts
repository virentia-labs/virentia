import * as core from "@virentia/core";
import type { EventPayload } from "@virentia/core";
import type { DomainLike } from "./domain-internal";
import { isEffect, isScope, isStore, isTargetable, isUnit } from "./guards";
import {
  applyScopeHandlers,
  createCompatScope,
  defaultScope,
  getCurrentWatchScope,
  seedStoreValues,
  withCurrentBoundScope,
} from "./shared";
import type {
  AnyUnit,
  Effect,
  Event,
  EventCallable,
  EventState,
  Scope,
  ScopeHandlers,
  StoreValues,
  StoreWritable,
} from "./types";

const activePromisesByScope = new WeakMap<Scope, Set<Promise<unknown>>>();

export function fork(config?: { values?: StoreValues; handlers?: ScopeHandlers }): Scope;
export function fork(
  domain: DomainLike,
  config?: { values?: StoreValues; handlers?: ScopeHandlers },
): Scope;
export function fork(
  domainOrConfig?: DomainLike | { values?: StoreValues; handlers?: ScopeHandlers },
  maybeConfig?: { values?: StoreValues; handlers?: ScopeHandlers },
): Scope {
  const domain = isDomainLike(domainOrConfig) ? domainOrConfig : undefined;
  const config = domain
    ? maybeConfig
    : (domainOrConfig as { values?: StoreValues; handlers?: ScopeHandlers } | undefined);
  const nextScope = createCompatScope(core.scope(), domain);

  if (config?.values) {
    seedStoreValues(nextScope, config.values);
  }

  if (config?.handlers) {
    applyScopeHandlers(nextScope, config.handlers);
  }

  return nextScope;
}

export async function allSettled<T>(
  unit: Event<T> | StoreWritable<T>,
  options?: { scope?: Scope; params?: T },
): Promise<void>;
export async function allSettled<Params, Done, Fail>(
  unit: Effect<Params, Done, Fail>,
  options?: { scope?: Scope; params?: Params },
): Promise<{ status: "done"; value: Done } | { status: "fail"; value: Fail }>;
export async function allSettled(
  unitOrScope: AnyUnit | Scope,
  options: { scope?: Scope; params?: unknown } = {},
): Promise<unknown> {
  if (isScope(unitOrScope)) {
    await waitForScope(unitOrScope);
    return;
  }

  if (!unitOrScope) {
    throw new Error("first argument should be unit");
  }

  if (!isUnit(unitOrScope)) {
    throw new Error("first argument accepts only effects, events, stores or scopes");
  }

  const scope = options.scope ?? createCompatScope(defaultScope);
  const unit = unitOrScope;

  if (!isTargetable(unit)) {
    throw new Error(`[allSettled] unit '${unit.shortName ?? "unit"}': unit should be targetable`);
  }

  if (isStore(unit)) {
    unit.setState(options.params, scope);
    return;
  }

  if (isEffect(unit)) {
    const promise = withCurrentBoundScope(scope, () =>
      core.scoped(scope.__core, () => unit(options.params)),
    );
    trackScopePromise(scope, promise);

    try {
      const value = await promise;
      return { status: "done", value };
    } catch (value) {
      return { status: "fail", value };
    }
  }

  await core.allSettled((unit as EventState<unknown>).__core, {
    scope: scope.__core,
    payload: options.params,
  });
}

function trackScopePromise(scope: Scope, promise: Promise<unknown>): void {
  const promises = activePromisesByScope.get(scope) ?? new Set<Promise<unknown>>();
  promises.add(promise);
  activePromisesByScope.set(scope, promises);

  void promise.then(
    () => {
      promises.delete(promise);
    },
    () => {
      promises.delete(promise);
    },
  );
}

async function waitForScope(scope: Scope): Promise<void> {
  while (true) {
    const promises = activePromisesByScope.get(scope);

    if (!promises?.size) {
      return;
    }

    await Promise.allSettled(promises);
  }
}

export function scopeBind<T>(
  unit: EventCallable<T> | Effect<T, any, any>,
  config?: { scope?: Scope; safe?: boolean },
): (...payload: EventPayload<T>) => unknown {
  const scope = config?.scope ?? getCurrentWatchScope();
  const runInScope = (nextScope: Scope, payload: EventPayload<T>) => {
    if (isUnit(unit) && !isEffect(unit)) {
      return core.allSettled((unit as EventState<T>).__core, {
        scope: nextScope.__core,
        payload: payload[0] as any,
      });
    }

    return withCurrentBoundScope(nextScope, () =>
      core.scoped(nextScope.__core, () => unit(...payload)),
    );
  };

  if (!scope) {
    if (config?.safe) {
      return (...payload: EventPayload<T>) => runInScope(createCompatScope(defaultScope), payload);
    }

    throw new Error("scopeBind: scope not found");
  }

  return (...payload: EventPayload<T>) => runInScope(scope, payload);
}

function isDomainLike(value: unknown): value is DomainLike {
  return Boolean(value && typeof value === "object" && "__domainState" in value);
}
