import * as core from "@virentia/core";
import type { EventCallable as CoreEvent, EventPayload } from "@virentia/core";
import { normalizeUnitConfig } from "./factory";
import { sample } from "./operators";
import { attachUnitRegion, withRegion } from "./region";
import { callWithFallback } from "./shared";
import { getUnitDomain, registerDomainUnit, type DomainLike } from "./domain-internal";
import {
  unitKind,
  type Event,
  type EventCallable,
  type EventState,
  type Unsubscribe,
} from "./types";
import { watchUnit } from "./watch";

interface EventConfig {
  name?: string;
  sid?: string | null;
  domain?: DomainLike;
  and?: unknown;
}

export function createEvent<T = void>(
  nameOrConfig?: string | EventConfig,
  maybeConfig?: EventConfig,
): EventCallable<T> {
  const rawConfig =
    typeof nameOrConfig === "string"
      ? maybeConfig
      : nameOrConfig === undefined
        ? maybeConfig
        : maybeConfig
          ? { ...maybeConfig, ...nameOrConfig }
          : nameOrConfig;
  const config = normalizeUnitConfig(rawConfig);
  const name = typeof nameOrConfig === "string" ? nameOrConfig : (config?.name ?? "unit");
  const domain = config?.domain;

  const create = () => {
    const event = wrapEvent(core.event<T>(), name, { sid: config?.sid });
    registerDomainUnit(domain, "event", event);
    return event;
  };

  return domain ? withRegion(domain.graphite, create) : create();
}

export function wrapEvent<T>(
  event: CoreEvent<T> | core.Event<T>,
  name = "event",
  options: { targetable?: boolean; sid?: string | null } = {},
): EventCallable<T> {
  const targetable = options.targetable ?? true;
  const callable = targetable
    ? typeof event === "function"
      ? event
      : (((...payload: EventPayload<T>) =>
          core.allSettled(event as core.Event<any>, {
            payload: payload[0] as core.UnitInput<core.Event<any>>,
          })) as CoreEvent<T>)
    : (((..._payload: EventPayload<T>) => {
        throw new Error(`[event] unit '${name}': call of derived event is not supported`);
      }) as unknown as CoreEvent<T>);
  const result = callWithFallback(callable as EventState<T>);

  Object.assign(result, {
    [unitKind]: "event" as const,
    kind: "event" as const,
    __core: event,
    node: event.node,
    shortName: name,
    sid: options.sid,
    targetable,
    getType: () => name,
    watch(fn: (payload: T) => void): Unsubscribe {
      return watchUnit(result, fn);
    },
    map<Next>(fn: (payload: T) => Next): Event<Next> {
      return wrapEvent(event.map(fn), `${name} → *`, { targetable: false });
    },
    filter(config: { fn(payload: T): boolean } | ((payload: T) => boolean)): Event<T> {
      const fn = typeof config === "function" ? config : config.fn;
      return wrapEvent(event.filter(fn), `${name} → *`, { targetable: false });
    },
    filterMap<Next>(fn: (payload: T) => Next | undefined): Event<Next> {
      return wrapEvent(event.filterMap(fn), `${name} → *`, { targetable: false });
    },
    prepend<Before>(fn: (payload: Before) => T): EventCallable<Before> {
      if (!targetable) {
        throw new Error(`[event] unit '${name}': .prepend of derived event is not supported`);
      }

      const prepended = createEvent<Before>({
        domain: getUnitDomain(result),
      });

      sample({
        clock: prepended,
        fn,
        target: result,
      });

      return prepended;
    },
  });

  attachUnitRegion(result);

  return result;
}
