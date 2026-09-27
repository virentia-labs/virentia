import { node, run } from "../kernel";
import type { Node } from "../kernel";
import { describeNode, readInspectorNodeMeta, withInspectorMeta } from "../kernel/inspector";
import { getActiveScope, requireActiveScope, setActiveScope } from "../scope/internal";
import { unwrapMicroScope } from "../scope/micro";
import { resolveStoreSid } from "../scope/snapshot";
import type { Scope } from "../scope/types";
import { registerCleanup } from "../graph/owner";

export type EventPayload<T> = undefined extends T ? [payload?: T] : [payload: T];

export interface Event<T = void> {
  readonly node: Node;
  readonly sid?: string;
  map<Next>(fn: (value: T) => Next): Event<Next>;
  filter(fn: (value: T) => boolean): Event<T>;
  filterMap<Next>(fn: (value: T) => Next | undefined): Event<Next>;
}

export interface EventCallable<T = void> extends Event<T> {
  (...payload: EventPayload<T>): Promise<void>;
}

export interface EventDevtoolsOptions {
  name?: string;
  key?: boolean;
  sid?: string;
}

const boundScopes = new WeakMap<object, Scope>();

/** @internal Scope attached to an event view without allocating another event node. */
export function boundEventScopeOf(source: unknown): Scope | undefined {
  if ((typeof source !== "object" || source === null) && typeof source !== "function") {
    return undefined;
  }

  return boundScopes.get(source);
}

/**
 * Bind an event to one scope while retaining its source node. Reactions on the
 * returned view infer that scope; map/filter descendants inherit it as well.
 */
export function bindEventToScope<T>(source: EventCallable<T>, scope: Scope): EventCallable<T>;
export function bindEventToScope<T>(source: Event<T>, scope: Scope): Event<T>;
export function bindEventToScope<T>(source: Event<T>, scope: Scope): Event<T> {
  const concreteScope = unwrapMicroScope(scope);
  const previousScope = boundEventScopeOf(source);
  if (previousScope && previousScope !== concreteScope) {
    throw new TypeError("[core] Event is already bound to a different scope");
  }
  const matchesScope = (): boolean => {
    const active = getActiveScope();
    return active !== null && unwrapMicroScope(active) === concreteScope;
  };
  const view = Object.assign(
    (...payload: EventPayload<T>) => {
      const ambient = getActiveScope();

      return run({ unit: source.node, payload: payload[0], scope: concreteScope }).finally(() =>
        setActiveScope(ambient),
      );
    },
    {
      node: source.node,
      sid: source.sid,
      map<Next>(fn: (value: T) => Next): Event<Next> {
        return bindEventToScope(source.filter(matchesScope).map(fn), concreteScope);
      },
      filter(fn: (value: T) => boolean): Event<T> {
        return bindEventToScope(
          source.filter((value) => matchesScope() && fn(value)),
          concreteScope,
        );
      },
      filterMap<Next>(fn: (value: T) => Next | undefined): Event<Next> {
        return bindEventToScope(
          source.filterMap((value) => (matchesScope() ? fn(value) : undefined)),
          concreteScope,
        );
      },
    },
  );
  boundScopes.set(view, concreteScope);

  return view;
}

export function event<T = void>(name?: string, metadata?: EventDevtoolsOptions): EventCallable<T>;
export function event<T = void>(
  devtools?: EventDevtoolsOptions,
  metadata?: EventDevtoolsOptions,
): EventCallable<T>;
export function event<T = void>(
  devtools?: string | EventDevtoolsOptions,
  metadata?: EventDevtoolsOptions,
): EventCallable<T> {
  return createEvent<T>(
    typeof devtools === "string" ? { ...metadata, name: devtools } : { ...metadata, ...devtools },
  ) as EventCallable<T>;
}

function createEvent<T>(devtools?: string | EventDevtoolsOptions): Event<T> {
  const options = normalizeDevtoolsOptions(devtools);
  if (options.sid !== undefined && (typeof options.sid !== "string" || !options.sid.length)) {
    throw new TypeError("Event SID must be a non-empty string");
  }
  const sid = resolveStoreSid(options.sid);
  const eventNode = node({
    meta: withInspectorMeta(undefined, {
      type: "event",
      name: options.name,
      key: options.key,
      callable: true,
      sid,
    }),
  });

  const append = (next: Node): void => {
    eventNode.next = eventNode.next ?? [];
    eventNode.next.push(next);

    registerCleanup(() => {
      const nextNodes = eventNode.next;
      if (!nextNodes) return;

      const index = nextNodes.indexOf(next);

      if (index >= 0) {
        nextNodes.splice(index, 1);
      }
    });
  };

  const result = Object.assign(
    (...payload: EventPayload<T>) => {
      // Restore the caller's ambient scope once the event (and any reactions it
      // triggers, including async ones) settles, so code after `await someEvent()`
      // still runs in the scope it was called in. Any async-callable unit must
      // leave the caller's scope as it found it.
      const ambient = requireActiveScope(() => `call ${describeNode(eventNode)}`);

      return run({
        unit: eventNode,
        payload: payload[0],
        scope: unwrapMicroScope(ambient),
      }).finally(() => setActiveScope(ambient));
    },
    {
      node: eventNode,
      sid,

      map<Next>(fn: (value: T) => Next): Event<Next> {
        const mapped = createEvent<Next>(deriveName(eventNode, "map"));

        append(
          node({
            run: (ctx) => fn(ctx.value as T),
            next: [mapped.node],
            meta: withInspectorMeta(undefined, {
              type: "event.map",
              internal: true,
            }),
          }),
        );

        return mapped;
      },

      filter(fn: (value: T) => boolean): Event<T> {
        const filtered = createEvent<T>(deriveName(eventNode, "filter"));

        append(
          node({
            run: (ctx) => {
              if (!fn(ctx.value as T)) {
                ctx.stop();
              }

              return ctx.value;
            },
            next: [filtered.node],
            meta: withInspectorMeta(undefined, {
              type: "event.filter",
              internal: true,
            }),
          }),
        );

        return filtered;
      },

      filterMap<Next>(fn: (value: T) => Next | undefined): Event<Next> {
        const mapped = createEvent<Next>(deriveName(eventNode, "filterMap"));

        append(
          node({
            run: (ctx) => {
              const value = fn(ctx.value as T);

              if (value === undefined) {
                ctx.stop();
              }

              return value;
            },
            next: [mapped.node],
            meta: withInspectorMeta(undefined, {
              type: "event.filterMap",
              internal: true,
            }),
          }),
        );

        return mapped;
      },
    },
  );

  return result as Event<T>;
}

function deriveName(source: Node, operation: string): string | undefined {
  const name = readInspectorNodeMeta(source).name;

  return name ? `${name}.${operation}` : undefined;
}

function normalizeDevtoolsOptions(
  devtools: string | EventDevtoolsOptions | undefined,
): EventDevtoolsOptions {
  return typeof devtools === "string" ? { name: devtools } : (devtools ?? {});
}
