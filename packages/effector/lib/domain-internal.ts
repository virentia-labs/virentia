import type { EventCallable } from "./types";
import type { Effect, StoreWritable } from "./types";
import type { Node } from "./region";

export type DomainUnitKind = "event" | "effect" | "store" | "domain";

export interface DomainLike {
  readonly graphite: Node;
  readonly history: DomainHistory;
  readonly hooks: DomainHooks;
  readonly __domainState: DomainState;
  getType(): string;
}

export interface DomainHistory {
  readonly events: Set<EventCallable<any>>;
  readonly effects: Set<Effect<any, any, any>>;
  readonly stores: Set<StoreWritable<any>>;
  readonly domains: Set<DomainLike>;
}

export interface DomainHooks {
  event(unit: EventCallable<any>): void;
  effect(unit: Effect<any, any, any>): void;
  store(unit: StoreWritable<any>): void;
  domain(unit: DomainLike): void;
}

export interface DomainState {
  readonly name: string;
  readonly fullName: string;
  readonly parent?: DomainLike;
  readonly history: DomainHistory;
  readonly hookSubscribers: {
    event: Set<(unit: EventCallable<any>) => void>;
    effect: Set<(unit: Effect<any, any, any>) => void>;
    store: Set<(unit: StoreWritable<any>) => void>;
    domain: Set<(unit: DomainLike) => void>;
  };
}

const unitDomains = new WeakMap<object, DomainLike>();

export function getUnitDomain(unit: unknown): DomainLike | undefined {
  return isObject(unit) ? unitDomains.get(unit) : undefined;
}

export function registerDomainUnit(
  domain: DomainLike | undefined,
  kind: DomainUnitKind,
  unit: EventCallable<any> | Effect<any, any, any> | StoreWritable<any> | DomainLike,
): void {
  if (!domain) {
    return;
  }

  unitDomains.set(unit as object, domain);
  notifyDomain(domain, kind, unit);
}

export function subscribeDomainHook<K extends DomainUnitKind>(
  domain: DomainLike,
  kind: K,
  fn: (unit: any) => void,
): () => void {
  const subscribers = domain.__domainState.hookSubscribers[kind] as Set<typeof fn>;
  subscribers.add(fn);

  for (const unit of getHistorySet(domain, kind)) {
    (fn as (unit: unknown) => void)(unit);
  }

  return () => {
    subscribers.delete(fn);
  };
}

function notifyDomain(
  domain: DomainLike,
  kind: DomainUnitKind,
  unit: EventCallable<any> | Effect<any, any, any> | StoreWritable<any> | DomainLike,
): void {
  getHistorySet(domain, kind).add(unit as never);

  const subscribers = domain.__domainState.hookSubscribers[kind] as Set<(unit: any) => void>;

  for (const fn of subscribers) {
    fn(unit);
  }

  if (domain.__domainState.parent) {
    notifyDomain(domain.__domainState.parent, kind, unit);
  }
}

function getHistorySet(domain: DomainLike, kind: DomainUnitKind): Set<unknown> {
  switch (kind) {
    case "event":
      return domain.history.events;
    case "effect":
      return domain.history.effects;
    case "store":
      return domain.history.stores;
    case "domain":
      return domain.history.domains;
  }
}

function isObject(value: unknown): value is object {
  return (typeof value === "object" || typeof value === "function") && value !== null;
}
