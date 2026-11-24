import { topologyChanged, topologyShrank } from "../kernel/topology";
import { node } from "../kernel";
import { runUnitScoped } from "../kernel/run";
import type { Node } from "../kernel";
import { describeNode, readInspectorNodeMeta, withInspectorMeta } from "../kernel/inspector";
import { getActiveScope, requireActiveScope } from "../scope/internal";
import { trackUnitDeclaration } from "../graph/declaration";
import { unwrapMicroScope } from "../scope/micro";
import { modelScopeInstance, resolveStoreSid } from "../scope/snapshot";
import type { Scope } from "../scope/types";
import { getOwner, owner as createOwner, setOwner, registerCleanup, type Owner } from "../graph/owner";

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

// The scope rides on the bound view itself: a WeakMap entry per bound view cost
// more than the view (ephemeron insertion and GC work for every model action).
export const boundScopeKey = Symbol("virentia.boundEventScope");

/** @internal Scope attached to an event view without allocating another event node. */
export function boundEventScopeOf(source: unknown): Scope | undefined {
  if (typeof source !== "function") return undefined;

  return (source as { [boundScopeKey]?: Scope })[boundScopeKey];
}

/**
 * Bind an event to one scope while retaining its source node. Reactions on the
 * returned view infer that scope; map/filter descendants inherit it as well.
 */
export function bindEventToScope<T>(
  source: EventCallable<T>,
  scope: Scope,
  guard?: () => void,
  owner?: Owner,
): EventCallable<T>;
export function bindEventToScope<T>(
  source: Event<T>,
  scope: Scope,
  guard?: () => void,
  owner?: Owner,
): Event<T>;
export function bindEventToScope<T>(
  source: Event<T>,
  scope: Scope,
  guard?: () => void,
  owner?: Owner,
): Event<T> {
  const concreteScope = unwrapMicroScope(scope);
  const previousScope = boundEventScopeOf(source);
  if (previousScope && previousScope !== concreteScope) {
    throw new TypeError("[core] Event is already bound to a different scope");
  }
  const view = (...payload: EventPayload<T>) => {
    guard?.();
    const ambient = getActiveScope();
    const caller = getOwner();
    // withOwner without its callback: a closure here would allocate per call.
    const callOwner = owner ?? caller;
    if (!callOwner) return runUnitScoped(source.node, concreteScope, payload[0], ambient, caller);
    const previousOwner = setOwner(callOwner);
    try {
      return runUnitScoped(source.node, concreteScope, payload[0], ambient, caller);
    } finally {
      setOwner(previousOwner);
    }
  };
  // map/filter/filterMap live on a shared prototype: a bound view per model
  // instance allocates no method closures until one of them is used.
  Object.setPrototypeOf(view, boundEventPrototype);
  const bound = view as unknown as BoundEvent<T>;
  bound.node = source.node;
  bound.sid = source.sid;
  bound[boundSource] = source as Event<unknown>;
  bound[boundScopeKey] = concreteScope;
  if (guard) bound[boundGuard] = guard;

  return bound as unknown as Event<T>;
}

const boundSource = Symbol("virentia.boundEventSource");
const boundGuard = Symbol("virentia.boundEventGuard");
interface BoundEvent<T> {
  node: Node;
  sid?: string;
  [boundSource]: Event<unknown>;
  [boundScopeKey]: Scope;
  [boundGuard]?: () => void;
  (...payload: EventPayload<T>): Promise<void>;
}
function deriveBoundEvent<T>(source: BoundEvent<unknown>, build: () => Event<T>): Event<T> {
  const scope = source[boundScopeKey], guard = source[boundGuard];
  guard?.();
  const model = modelScopeInstance(scope) as { beforeDispose?(callback: () => void): () => void } | undefined;
  if (!model?.beforeDispose) return bindEventToScope(build(), scope, guard);
  return createOwner(dispose => {
    const result = bindEventToScope(build(), scope, guard);
    registerCleanup(model.beforeDispose!(dispose));
    return result;
  });
}
function scopeMatcher(scope: Scope): () => boolean {
  return () => {
    const active = getActiveScope();
    return active !== null && unwrapMicroScope(active) === scope;
  };
}
const boundEventPrototype: object = Object.create(Function.prototype, {
  map: {
    configurable: true,
    writable: true,
    value<Next>(this: BoundEvent<unknown>, fn: (value: unknown) => Next): Event<Next> {
      const scope = this[boundScopeKey];
      return deriveBoundEvent(this, () => this[boundSource].filter(scopeMatcher(scope)).map(fn));
    },
  },
  filter: {
    configurable: true,
    writable: true,
    value(this: BoundEvent<unknown>, fn: (value: unknown) => boolean): Event<unknown> {
      const scope = this[boundScopeKey];
      const matches = scopeMatcher(scope);
      return deriveBoundEvent(this, () => this[boundSource].filter((value) => matches() && fn(value)));
    },
  },
  filterMap: {
    configurable: true,
    writable: true,
    value<Next>(this: BoundEvent<unknown>, fn: (value: unknown) => Next | undefined): Event<Next> {
      const scope = this[boundScopeKey];
      const matches = scopeMatcher(scope);
      return deriveBoundEvent(this, () => this[boundSource].filterMap((value) => (matches() ? fn(value) : undefined)));
    },
  },
});

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
  trackUnitDeclaration("event");
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
    if (eventNode.next) eventNode.next.push(next);
    else eventNode.next = [next];
    topologyChanged();

    registerCleanup(() => {
      const nextNodes = eventNode.next;
      if (!nextNodes) return;

      const index = nextNodes.indexOf(next);

      if (index >= 0) {
        nextNodes.splice(index, 1);
        topologyShrank();
      }
    });
  };

  const describeCall = () => `call ${describeNode(eventNode)}`;
  const result = Object.assign(
    (...payload: EventPayload<T>) => {
      // Restore the caller's ambient scope once the event (and any reactions it
      // triggers, including async ones) settles, so code after `await someEvent()`
      // still runs in the scope it was called in. Any async-callable unit must
      // leave the caller's scope as it found it.
      const ambient = requireActiveScope(describeCall);

      return runUnitScoped(eventNode, unwrapMicroScope(ambient), payload[0], ambient);
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
