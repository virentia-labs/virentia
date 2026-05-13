import * as core from "@virentia/core";
import type { Store as CoreStore, StoreWritable as CoreStoreWritable } from "@virentia/core";
import { wrapEvent } from "./event";
import { normalizeUnitConfig } from "./factory";
import { isEffect } from "./guards";
import { attachUnitRegion, withRegion } from "./region";
import { registerDomainUnit, type DomainLike } from "./domain-internal";
import { createSubscription } from "./watch";
import {
  defaultScope,
  inScope,
  markScopeChanged,
  nativeStoreKeys,
  registerStore,
  toArray,
  withCurrentWatchScope,
} from "./shared";
import {
  unitKind,
  type Event,
  type EventState,
  type Scope,
  type Store,
  type StoreMapConfig,
  type StoreSerializeConfig,
  type StoreState,
  type StoreWritable,
  type Unit,
  type Unsubscribe,
} from "./types";

interface StoreUpdateOptions<T> {
  skipVoid?: boolean;
  updateFilter?: (update: T, current: T) => boolean;
}

const storeUpdateOptions = new WeakMap<
  object,
  StoreUpdateOptions<any> & {
    name: string;
  }
>();

export function createStore<T>(
  defaultState: T,
  config?: {
    name?: string;
    sid?: string | null;
    serialize?: StoreSerializeConfig<T>;
    skipVoid?: boolean;
    updateFilter?: (update: T, current: T) => boolean;
    domain?: DomainLike;
    and?: unknown;
  },
): StoreWritable<T> {
  const { domain, ...storeConfig } = normalizeUnitConfig(config) ?? {};

  const create = (): StoreWritable<T> => {
    if (defaultState === undefined && storeConfig.skipVoid !== false) {
      throw new Error(createSkipVoidMessage(storeConfig.name ?? "store"));
    }

    if (storeConfig.skipVoid === true) {
      warnSkipVoidDeprecated(storeConfig.name ?? "store");
    }

    const box = core.store({ value: defaultState });
    const updates = wrapEvent<T>(core.event<T>(), `${storeConfig.name ?? "store"} updates`, {
      targetable: false,
    });
    const store = createStoreFromBox(
      box,
      updates,
      defaultState,
      storeConfig.name,
      storeConfig.sid ?? undefined,
      {
        targetable: true,
        serialize: storeConfig.serialize,
        skipVoid: storeConfig.skipVoid,
        updateFilter: storeConfig.updateFilter,
      },
    );

    registerStore(store);
    registerDomainUnit(domain, "store", store);

    return store;
  };

  return domain ? withRegion(domain.graphite, create) : create();
}

export function createStoreFromBox<T>(
  box: CoreStoreWritable<{ value: T }>,
  updates: Event<T>,
  defaultState: T,
  name = "store",
  sid?: string,
  options: {
    targetable?: boolean;
    skipVoid?: boolean;
    serialize?: StoreSerializeConfig<T>;
    updateFilter?: (update: T, current: T) => boolean;
    read?: (scope?: Scope) => T;
  } = {},
): StoreWritable<T> {
  const targetable = options.targetable ?? true;
  const subscriptions = new Map<Unit<any>, core.Reaction[]>();
  const reinit = wrapEvent<void>(core.event<void>(), `${name}.reinit`, { targetable });

  const assertWritable = (method: string): void => {
    if (!targetable) {
      throw new Error(`[store] unit '${name}': .${method} of derived store is not supported`);
    }
  };

  const result = {
    [unitKind]: "store" as const,
    kind: "store" as const,
    __box: box,
    __core: updates,
    node: (updates as EventState<T>).__core.node,
    shortName: name,
    targetable,
    sid,
    serialize: options.serialize,
    defaultState,
    reinit,
    updates,
    getType: () => name,
    getState(scope?: Scope): T {
      if (options.read) {
        return options.read(scope);
      }

      return readBox(box, scope);
    },
    setState(value: T, scope?: Scope): void {
      assertWritable("setState");

      const next = runStoreSteps(result, value, scope);

      if (!shouldUpdateBox(box, next, scope, { ...options, name })) {
        return;
      }

      writeBox(box, next, scope);
    },
    watch(
      fnOrUnit: ((payload: T) => void) | Unit<any>,
      maybeFn?: (payload: T) => void,
    ): Unsubscribe {
      if (maybeFn) {
        const trigger = fnOrUnit as Unit<any>;
        const fn = maybeFn;

        const subscription = core.reaction({
          on: reactionSource(trigger),
          run: () => {
            fn(result.getState());
          },
        });

        return createSubscription(() => subscription.stop());
      }

      const fn = fnOrUnit as (payload: T) => void;
      if (typeof fn !== "function") {
        throw new Error(".watch argument should be a function");
      }

      fn(readBox(box));

      return createSubscription(
        box.subscribe((next, scope) => {
          withCurrentWatchScope(scope, () => {
            fn(next.value);
          });
        }),
      );
    },
    map<Next>(fn: (state: T) => Next, config?: StoreMapConfig): Store<Next> {
      const mapConfig = normalizeUnitConfig(config);
      const mappedName = mapConfig?.name ?? `${name} → *`;
      const current = readBox((result as StoreState<T>).__box);
      const initial = current === undefined ? undefined : fn(current);
      const mappedBox = core.store({ value: initial as Next });

      warnInitialSkipVoid(initial, mappedName, mapConfig?.skipVoid);
      const mapped = createStoreFromBox<Next>(
        mappedBox,
        wrapEvent<Next>(core.event<Next>(), `${mappedName} updates`, { targetable: false }),
        initial as Next,
        mappedName,
        mapConfig?.sid ?? undefined,
        {
          targetable: false,
          skipVoid: mapConfig?.skipVoid,
          read: (scope) => {
            if (!scope) {
              return readBox(mappedBox);
            }

            const state = result.getState(scope);
            const previous = readBox(mappedBox, scope);

            if (state === undefined) {
              return previous;
            }

            const next = fn(state);

            return shouldAcceptUndefined(next, mapConfig?.skipVoid) ? next : previous;
          },
        },
      );

      core.reaction({
        on: result.updates,
        run: (state) => {
          if (state === undefined) {
            return;
          }

          const next = fn(state);

          if (
            !shouldUpdateBox(mappedBox, next, undefined, {
              name: mappedName,
              skipVoid: mapConfig?.skipVoid,
            })
          ) {
            return;
          }

          writeBox(mappedBox, next);
        },
      });

      return mapped;
    },
    on<Payload>(
      trigger: Unit<Payload>,
      reducer: (state: T, payload: Payload) => T,
    ): StoreWritable<T> {
      assertWritable("on");
      assertUnitList("on", trigger);

      const subscription = core.reaction({
        on: reactionSource(trigger),
        run: (payload: Payload) => {
          result.setState(reducer(result.getState(), payload));
        },
      });

      const list = subscriptions.get(trigger) ?? [];
      list.push(subscription);
      subscriptions.set(trigger, list);

      return result;
    },
    off(trigger: Unit<any>): StoreWritable<T> {
      assertWritable("off");

      for (const subscription of subscriptions.get(trigger) ?? []) {
        subscription.stop();
      }

      subscriptions.delete(trigger);
      return result;
    },
    reset(trigger: Unit<any> | readonly Unit<any>[], ...rest: Unit<any>[]): StoreWritable<T> {
      assertWritable("reset");
      const triggers = rest.length > 0 ? [...toArray(trigger), ...rest] : toArray(trigger);

      assertUnitList("reset", triggers);

      for (const unit of triggers) {
        const subscription = core.reaction({
          on: reactionSource(unit),
          run: () => {
            result.setState(defaultState);
          },
        });

        const list = subscriptions.get(unit) ?? [];
        list.push(subscription);
        subscriptions.set(unit, list);
      }

      return result;
    },
  } satisfies StoreState<T>;

  if (targetable) {
    const subscription = core.reaction({
      on: reinit,
      run: () => {
        result.setState(defaultState);
      },
    });

    subscriptions.set(reinit, [subscription]);
  }

  Object.defineProperty(result, "__box", {
    configurable: true,
    enumerable: false,
    value: box,
  });
  Object.defineProperty(result, Symbol.for("chai/inspect"), {
    configurable: true,
    value: () => `Store(${name})`,
  });
  Object.defineProperty(result, Symbol.for("nodejs.util.inspect.custom"), {
    configurable: true,
    value: () => `Store(${name})`,
  });

  function assertUnitList(method: string, input: Unit<any> | readonly Unit<any>[]): void {
    const units = toArray(input);

    if (
      units.length === 0 ||
      units.some((unit) => {
        const unitType = typeof unit;

        return !unit || (unitType !== "object" && unitType !== "function") || !unit.node;
      })
    ) {
      throw new Error(
        `[store] unit '${name}' .${method}: expect first argument to be a unit (store, event or effect) or array of units`,
      );
    }
  }

  attachUnitRegion(result);
  storeUpdateOptions.set(result, {
    name,
    skipVoid: options.skipVoid,
    updateFilter: options.updateFilter,
  });

  box.subscribe((next, scope) => {
    markScopeChanged(scope, result.sid);

    void core.run({
      unit: (updates as EventState<T>).__core.node,
      payload: next.value,
      scope,
    });
  });

  return result;
}

export function updateStoreFromDerived<T>(store: Store<T>, value: T, scope?: Scope): void {
  const state = store as StoreState<T>;
  const options = storeUpdateOptions.get(store as object) ?? {
    name: store.shortName,
  };

  if (!shouldUpdateBox(state.__box, value, scope, options)) {
    return;
  }

  writeBox(state.__box, value, scope);
}

export function wrapNativeStore<T>(store: CoreStore<T>, defaultState: T, name: string): Store<T> {
  const updates = wrapEvent<T>(core.event<T>(), `${name}.updates`, { targetable: false });
  const result = {
    [unitKind]: "store" as const,
    kind: "store" as const,
    __core: updates,
    node: (updates as EventState<T>).__core.node,
    shortName: name,
    targetable: false,
    defaultState,
    reinit: wrapEvent<void>(core.event<void>(), `${name}.reinit`, { targetable: false }),
    updates,
    getType: () => name,
    getState(scope?: Scope): T {
      return readNativeStore(store, scope);
    },
    watch(fn: (payload: T) => void): Unsubscribe {
      if (typeof fn !== "function") {
        throw new Error(".watch argument should be a function");
      }

      fn(readNativeStore(store));

      return createSubscription(
        store.subscribe((next, scope) => {
          withCurrentWatchScope(scope, () => {
            fn(next);
          });
        }),
      );
    },
    map<Next>(fn: (state: T) => Next): Store<Next> {
      const mapped = createStore(fn(result.getState()));

      core.scoped(defaultScope, () => {
        core.reaction(() => {
          const next = fn(result.getState());

          if (shouldUpdateBox((mapped as StoreState<Next>).__box, next, undefined, {})) {
            mapped.setState(next);
          }
        });
      });

      return mapped;
    },
    on(): Store<T> {
      throw new Error("Store is read-only");
    },
    off(): Store<T> {
      throw new Error("Store is read-only");
    },
    reset(): Store<T> {
      throw new Error("Store is read-only");
    },
  };

  attachUnitRegion(result as unknown as StoreState<T>);

  store.subscribe((next, scope) => {
    void core.run({
      unit: (updates as EventState<T>).__core.node,
      payload: next,
      scope,
    });
  });

  return result as unknown as Store<T>;
}

function readBox<T>(box: CoreStoreWritable<{ value: T }>, scope?: Scope): T {
  return inScope(scope, () => box.value);
}

function writeBox<T>(box: CoreStoreWritable<{ value: T }>, value: T, scope?: Scope): void {
  inScope(scope, () => {
    box.value = value;
  });
}

function shouldUpdateBox<T>(
  box: CoreStoreWritable<{ value: T }>,
  value: T,
  scope: Scope | undefined,
  options: {
    name?: string;
    skipVoid?: boolean;
    updateFilter?: (update: T, current: T) => boolean;
  },
): boolean {
  const current = readBox(box, scope);

  if (value === undefined && options.skipVoid !== false) {
    if (options.skipVoid !== true) {
      warnSkipVoid(options.name ?? "store");
    }

    return false;
  }

  if (Object.is(current, value)) {
    return false;
  }

  if (options.updateFilter) {
    try {
      return options.updateFilter(value, current);
    } catch (error) {
      console.error(error);
      return false;
    }
  }

  return true;
}

function runStoreSteps<T>(store: Store<T>, value: T, scope: Scope | undefined): T {
  const steps = ((store as any).graphite?.seq ?? []) as Array<{
    type?: string;
    fn?: (payload: unknown, scope?: unknown, stack?: { a?: unknown }) => unknown;
  }>;

  if (steps.length === 0) {
    return value;
  }

  let next: unknown = value;
  const stack = {
    a: store.getState(scope),
  };

  for (const step of steps) {
    if (!step || typeof step.fn !== "function") {
      continue;
    }

    if (step.type === "compute") {
      const result = step.fn(next, undefined, stack);

      if (result !== undefined) {
        next = result;
      }

      continue;
    }

    if (step.type === "run") {
      step.fn(next, undefined, stack);
    }
  }

  return next as T;
}

function shouldAcceptUndefined<T>(value: T, skipVoid: boolean | undefined): boolean {
  return value !== undefined || skipVoid === false;
}

function warnInitialSkipVoid(value: unknown, name: string, skipVoid: boolean | undefined): void {
  if (skipVoid === true) {
    warnSkipVoidDeprecated(name);
    return;
  }

  if (value === undefined && skipVoid !== false) {
    warnSkipVoid(name);
  }
}

function createSkipVoidMessage(name: string): string {
  return `[store] unit '${name}': undefined is used to skip updates. To allow undefined as a value provide explicit { skipVoid: false } option`;
}

function warnSkipVoid(name: string): void {
  console.error(createSkipVoidMessage(name));
}

function warnSkipVoidDeprecated(name: string): void {
  console.error(`[store] unit '${name}': {skipVoid: true} is deprecated, use updateFilter instead`);
}

function readNativeStore<T>(store: CoreStore<T>, scope?: Scope): T {
  return inScope(scope, () => {
    const keys = Reflect.ownKeys(store).filter((key) => !nativeStoreKeys.has(key));

    if (keys.length === 1 && keys[0] === "value") {
      return Reflect.get(store, "value") as T;
    }

    return Object.fromEntries(keys.map((key) => [key, Reflect.get(store, key)])) as T;
  });
}

function reactionSource<T>(unit: Unit<T> | readonly Unit<T>[]): Unit<T> | readonly Unit<T>[] {
  if (Array.isArray(unit)) {
    return unit.map((item) => reactionSource(item));
  }

  return isEffect(unit) ? (((unit as any).__started ?? (unit as any).__core.started) as Unit<T>) : unit;
}
