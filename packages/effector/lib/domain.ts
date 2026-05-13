import { createEffect } from "./effect";
import { createEvent } from "./event";
import { normalizeUnitConfig } from "./factory";
import { createNode, withRegion } from "./region";
import { createStore } from "./store";
import {
  registerDomainUnit,
  subscribeDomainHook,
  type DomainHistory,
  type DomainHooks,
  type DomainLike,
  type DomainState,
} from "./domain-internal";
import type { Effect, EventCallable, StoreWritable } from "./types";

export type Domain = DomainLike & {
  readonly shortName: string;
  readonly parent?: Domain;
  createEvent<T = void>(
    nameOrConfig?: string | { name?: string; sid?: string | null; and?: unknown },
    maybeConfig?: { name?: string; sid?: string | null; and?: unknown },
  ): EventCallable<T>;
  event<T = void>(
    nameOrConfig?: string | { name?: string; sid?: string | null; and?: unknown },
    maybeConfig?: { name?: string; sid?: string | null; and?: unknown },
  ): EventCallable<T>;
  createEffect<Params = void, Done = void, Fail = Error>(
    handlerOrConfig?:
      | string
      | ((params: Params) => Done | PromiseLike<Done>)
      | {
          name?: string;
          sid?: string | null;
          handler?: (params: Params) => Done | PromiseLike<Done>;
        },
  ): Effect<Params, Done, Fail>;
  effect<Params = void, Done = void, Fail = Error>(
    handlerOrConfig?:
      | string
      | ((params: Params) => Done | PromiseLike<Done>)
      | {
          name?: string;
          sid?: string | null;
          handler?: (params: Params) => Done | PromiseLike<Done>;
        },
  ): Effect<Params, Done, Fail>;
  createStore<T>(defaultState: T, config?: Parameters<typeof createStore<T>>[1]): StoreWritable<T>;
  store<T>(defaultState: T, config?: Parameters<typeof createStore<T>>[1]): StoreWritable<T>;
  createDomain(
    nameOrConfig?: string | { name?: string; domain?: Domain },
    maybeConfig?: { name?: string; domain?: Domain },
  ): Domain;
  domain(
    nameOrConfig?: string | { name?: string; domain?: Domain },
    maybeConfig?: { name?: string; domain?: Domain },
  ): Domain;
  onCreateEvent(fn: (unit: EventCallable<any>) => void): () => void;
  onCreateEffect(fn: (unit: Effect<any, any, any>) => void): () => void;
  onCreateStore(fn: (unit: StoreWritable<any>) => void): () => void;
  onCreateDomain(fn: (unit: Domain) => void): () => void;
};

export function createDomain(nameOrConfig?: string | { name?: string; domain?: Domain }): Domain {
  const normalizedConfig =
    typeof nameOrConfig === "string" ? undefined : normalizeUnitConfig(nameOrConfig);
  const parent = normalizedConfig?.domain;
  const name = typeof nameOrConfig === "string" ? nameOrConfig : (normalizedConfig?.name ?? "");
  const shortName = name || parent?.shortName || "";
  const fullName = name ? joinDomainName(parent?.getType() ?? "", name) : (parent?.getType() ?? "");
  const graphite = createNode({ meta: { type: "domain", name: fullName } });
  const history: DomainHistory = {
    events: new Set(),
    effects: new Set(),
    stores: new Set(),
    domains: new Set(),
  };
  const state: DomainState = {
    name: shortName,
    fullName,
    parent,
    history,
    hookSubscribers: {
      event: new Set(),
      effect: new Set(),
      store: new Set(),
      domain: new Set(),
    },
  };

  const hooks: DomainHooks = {
    event(unit) {
      registerDomainUnit(domain, "event", unit);
    },
    effect(unit) {
      registerDomainUnit(domain, "effect", unit);
    },
    store(unit) {
      registerDomainUnit(domain, "store", unit);
    },
    domain(unit) {
      registerDomainUnit(domain, "domain", unit);
    },
  };

  const domain = {
    shortName,
    parent,
    graphite,
    history,
    hooks,
    __domainState: state,
    getType: () => fullName,
    createEvent<T = void>(
      eventNameOrConfig?: string | { name?: string; sid?: string | null; and?: unknown },
      maybeConfig?: { name?: string; sid?: string | null; and?: unknown },
    ): EventCallable<T> {
      return withRegion(graphite, () => {
        const unitConfig = createDomainUnitConfig(eventNameOrConfig, maybeConfig);
        const unit = createEvent<T>(unitConfig);
        overrideUnitType(unit, joinDomainName(fullName, unitConfig.name));
        registerDomainUnit(domain, "event", unit);
        return unit;
      });
    },
    event<T = void>(
      eventNameOrConfig?: string | { name?: string; sid?: string | null; and?: unknown },
      maybeConfig?: { name?: string; sid?: string | null; and?: unknown },
    ): EventCallable<T> {
      return domain.createEvent<T>(eventNameOrConfig, maybeConfig);
    },
    createEffect<Params = void, Done = void, Fail = Error>(
      handlerOrConfig?:
        | string
        | ((params: Params) => Done | PromiseLike<Done>)
        | {
            name?: string;
            sid?: string | null;
            handler?: (params: Params) => Done | PromiseLike<Done>;
          },
      maybeConfig?: {
        name?: string;
        sid?: string | null;
        handler?: (params: Params) => Done | PromiseLike<Done>;
        and?: unknown;
      },
    ): Effect<Params, Done, Fail> {
      return withRegion(graphite, () => {
        const unit = createEffect<Params, Done, Fail>(
          createDomainEffectConfig(handlerOrConfig, maybeConfig),
        );
        overrideUnitType(unit, joinDomainName(fullName, unit.shortName));
        registerDomainUnit(domain, "effect", unit);
        return unit;
      });
    },
    effect<Params = void, Done = void, Fail = Error>(
      handlerOrConfig?:
        | string
        | ((params: Params) => Done | PromiseLike<Done>)
        | {
            name?: string;
            sid?: string | null;
            handler?: (params: Params) => Done | PromiseLike<Done>;
          },
      maybeConfig?: {
        name?: string;
        sid?: string | null;
        handler?: (params: Params) => Done | PromiseLike<Done>;
        and?: unknown;
      },
    ): Effect<Params, Done, Fail> {
      return domain.createEffect<Params, Done, Fail>(handlerOrConfig as any, maybeConfig);
    },
    createStore<T>(
      defaultState: T,
      config?: Parameters<typeof createStore<T>>[1],
    ): StoreWritable<T> {
      const normalizedConfig = normalizeUnitConfig(config);

      if (normalizedConfig?.domain) {
        return (normalizedConfig.domain as Domain).createStore(defaultState, {
          ...normalizedConfig,
          domain: undefined,
        });
      }

      return withRegion(graphite, () => {
        const unit = createStore(defaultState, normalizedConfig);
        registerDomainUnit(domain, "store", unit);
        return unit;
      });
    },
    store<T>(defaultState: T, config?: Parameters<typeof createStore<T>>[1]): StoreWritable<T> {
      return domain.createStore(defaultState, config);
    },
    createDomain(
      childNameOrConfig?: string | { name?: string; domain?: Domain },
      maybeConfig?: { name?: string; domain?: Domain },
    ): Domain {
      const childConfig =
        childNameOrConfig === undefined && maybeConfig ? maybeConfig : childNameOrConfig;
      const targetParent =
        typeof childConfig === "object" && childConfig.domain ? childConfig.domain : domain;
      const childName = typeof childConfig === "string" ? childConfig : childConfig?.name;
      const child = withRegion(graphite, () =>
        createDomain({
          name: childName,
          domain: targetParent,
        }),
      );

      return child;
    },
    domain(
      childNameOrConfig?: string | { name?: string; domain?: Domain },
      maybeConfig?: { name?: string; domain?: Domain },
    ): Domain {
      return domain.createDomain(childNameOrConfig, maybeConfig);
    },
    onCreateEvent(fn: (unit: EventCallable<any>) => void): () => void {
      return subscribeDomainHook(domain, "event", fn);
    },
    onCreateEffect(fn: (unit: Effect<any, any, any>) => void): () => void {
      return subscribeDomainHook(domain, "effect", fn);
    },
    onCreateStore(fn: (unit: StoreWritable<any>) => void): () => void {
      return subscribeDomainHook(domain, "store", fn);
    },
    onCreateDomain(fn: (unit: Domain) => void): () => void {
      return subscribeDomainHook(domain, "domain", fn as (unit: DomainLike) => void);
    },
  } satisfies Domain;

  registerDomainUnit(parent, "domain", domain);

  return domain;
}

function joinDomainName(parentName: string, name: string): string {
  if (!parentName) {
    return name;
  }

  if (!name) {
    return parentName;
  }

  return `${parentName}/${name}`;
}

function createDomainUnitConfig(
  nameOrConfig: string | { name?: string; sid?: string | null; and?: unknown } | undefined,
  maybeConfig: { name?: string; sid?: string | null; and?: unknown } | undefined,
): { name: string; sid?: string | null; and?: unknown } {
  const rawConfig =
    typeof nameOrConfig === "string"
      ? maybeConfig
      : nameOrConfig === undefined
        ? maybeConfig
        : maybeConfig
          ? { ...maybeConfig, ...nameOrConfig }
          : nameOrConfig;
  const config = normalizeUnitConfig(rawConfig);
  const localName = typeof nameOrConfig === "string" ? nameOrConfig : (config?.name ?? "unit");

  return {
    ...config,
    name: localName,
  };
}

function createDomainEffectConfig<Params, Done>(
  handlerOrConfig:
    | string
    | ((params: Params) => Done | PromiseLike<Done>)
    | {
        name?: string;
        sid?: string | null;
        handler?: (params: Params) => Done | PromiseLike<Done>;
        and?: unknown;
      }
    | undefined,
  maybeConfig:
    | {
        name?: string;
        sid?: string | null;
        handler?: (params: Params) => Done | PromiseLike<Done>;
        and?: unknown;
      }
    | undefined,
): {
  name: string;
  sid?: string | null;
  handler?: (params: Params) => Done | PromiseLike<Done>;
  and?: unknown;
} {
  const rawConfig =
    typeof handlerOrConfig === "string" || typeof handlerOrConfig === "function"
      ? maybeConfig
      : handlerOrConfig === undefined
        ? maybeConfig
        : maybeConfig
          ? { ...maybeConfig, ...handlerOrConfig }
          : handlerOrConfig;
  const config = normalizeUnitConfig(rawConfig);
  const localName =
    typeof handlerOrConfig === "string"
      ? handlerOrConfig
      : typeof handlerOrConfig === "function"
        ? (config?.name ?? "unit")
        : (config?.name ?? "unit");

  return {
    ...config,
    handler: typeof handlerOrConfig === "function" ? handlerOrConfig : config?.handler,
    name: localName,
  };
}

function overrideUnitType(unit: { getType(): string }, type: string): void {
  Object.defineProperty(unit, "getType", {
    configurable: true,
    enumerable: true,
    value: () => type,
  });
  Object.defineProperty(unit, "compositeName", {
    configurable: true,
    enumerable: true,
    value: {
      shortName: type.split("/").at(-1) ?? type,
      fullName: type,
      path: type.split("/").filter(Boolean),
    },
  });
}
