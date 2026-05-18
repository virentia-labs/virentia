import { createNode } from "../kernel";
import type { Node } from "../kernel";
import { withInspectorMeta } from "../kernel/inspector";
import { getActiveScope, setActiveScope } from "../scope/internal";
import type { Scope } from "../scope";
import { collectNodes } from "./deps";
import { registerCleanup } from "./owner";
import type { Effect } from "../units/effect";
import type { Event, EventCallable } from "../units/event";
import type { Store, StoreWritable } from "../units/store";

export interface Unit<_T = unknown> {
  readonly node: Node;
}

export type AnyUnit = Unit<any>;
export type WatchableUnit<T> = Unit<T> & {
  watch(fn: (payload: T) => unknown): unknown;
};
export type SourceUnit<T> =
  | Store<T>
  | StoreWritable<T>
  | EventCallable<T>
  | Event<T>
  | Effect<T, any, any>
  | WatchableUnit<T>;
export type UnitList<T = any> = SourceUnit<T> | readonly SourceUnit<T>[];

export type UnitInput<T> =
  T extends Store<infer Value>
    ? Value
    : T extends StoreWritable<infer Value>
      ? Value
      : T extends EventCallable<infer Payload>
        ? Payload
        : T extends Event<infer Payload>
          ? Payload
          : T extends Effect<infer Params, infer _Done, infer _Fail>
            ? Params
            : T extends Unit<infer Payload>
              ? Payload
              : never;

export type SourceInput<T> = T extends readonly (infer Item)[] ? UnitInput<Item> : UnitInput<T>;

export interface Reaction {
  readonly node: Node;
  readonly explicit: boolean;
  dependencies(): readonly Node[];
  stop(): void;
}

export interface ReactionConfig<Payload, On extends UnitList<Payload> = UnitList<Payload>> {
  on: On;
  name?: string;
  key?: boolean;
  scope?: Scope | readonly Scope[];
  run: (payload: Payload) => void;
}

export interface AutoReactionConfig {
  name?: string;
  key?: boolean;
  scope?: Scope | readonly Scope[];
  run(): void;
}

export function reaction<On extends readonly SourceUnit<any>[]>(config: {
  on: On;
  run: (payload: SourceInput<On>) => void;
}): Reaction;
export function reaction<Payload>(
  config: ReactionConfig<Payload, StoreWritable<Payload>>,
): Reaction;
export function reaction<Payload>(config: ReactionConfig<Payload, Store<Payload>>): Reaction;
export function reaction<Payload>(
  config: ReactionConfig<Payload, EventCallable<Payload>>,
): Reaction;
export function reaction<Payload>(config: ReactionConfig<Payload, Event<Payload>>): Reaction;
export function reaction<Payload, Done, Fail>(
  config: ReactionConfig<Payload, Effect<Payload, Done, Fail>>,
): Reaction;
export function reaction<Payload>(
  config: ReactionConfig<Payload, WatchableUnit<Payload>>,
): Reaction;
export function reaction(run: () => void): Reaction;
export function reaction(config: AutoReactionConfig): Reaction;
export function reaction(
  input: (() => void) | AutoReactionConfig | ReactionConfig<any, UnitList>,
): Reaction {
  const explicit = typeof input === "object" && "on" in input;
  const runHandler = typeof input === "function" ? input : input.run;
  const name = typeof input === "object" ? input.name : undefined;
  const key = typeof input === "object" ? input.key : undefined;
  const configuredScopes = typeof input === "object" && input.scope ? toArray(input.scope) : null;
  const allowedScopes = configuredScopes ? new Set(configuredScopes) : null;
  const currentDependencies = new Set<Node>();
  let stopped = false;

  const node = createNode({
    meta: withInspectorMeta(undefined, {
      type: "reaction",
      name,
      key,
      internal: false,
    }),
    run: (ctx) => {
      if (stopped || !matchesScope(allowedScopes, ctx.scope)) {
        return ctx.value;
      }

      if (explicit) {
        (runHandler as (payload: unknown) => void)(ctx.value);
      } else {
        runAuto();
      }

      return ctx.value;
    },
  });

  const runAuto = (): void => {
    const activeScope = getActiveScope();
    const configuredScope = configuredScopes?.[0];
    const scopeForRun = configuredScope ?? activeScope;
    const trackingScope = activeScope ? null : createTrackingScope();
    const previousScope =
      scopeForRun && scopeForRun !== activeScope
        ? setActiveScope(scopeForRun)
        : trackingScope
          ? setActiveScope(trackingScope)
          : null;

    try {
      const collected = collectNodes(() => {
        (runHandler as () => void)();
      });

      reconcileDependencies(node, currentDependencies, collected.nodes);
    } finally {
      if (scopeForRun && scopeForRun !== activeScope) {
        setActiveScope(previousScope);
      } else if (trackingScope) {
        setActiveScope(previousScope);
      }
    }
  };

  if (explicit) {
    for (const source of toArray(input.on)) {
      attach(source.node, node);
      currentDependencies.add(source.node);
    }
  } else {
    runAuto();
  }

  const result: Reaction = {
    node,
    explicit,

    dependencies(): readonly Node[] {
      return [...currentDependencies];
    },

    stop(): void {
      stopped = true;

      for (const dependency of currentDependencies) {
        detach(dependency, node);
      }

      currentDependencies.clear();
    },
  };

  registerCleanup(() => {
    result.stop();
  });

  return result;
}

function reconcileDependencies(node: Node, current: Set<Node>, next: Set<Node>): void {
  for (const dependency of current) {
    if (!next.has(dependency)) {
      detach(dependency, node);
      current.delete(dependency);
    }
  }

  for (const dependency of next) {
    if (!current.has(dependency)) {
      attach(dependency, node);
      current.add(dependency);
    }
  }
}

function attach(source: Node, next: Node): void {
  source.next = source.next ?? [];

  if (!source.next.includes(next)) {
    source.next.push(next);
  }
}

function detach(source: Node, next: Node): void {
  if (!source.next) return;

  const index = source.next.indexOf(next);

  if (index >= 0) {
    source.next.splice(index, 1);
  }
}

function toArray<T>(value: T | readonly T[]): readonly T[] {
  return Array.isArray(value) ? (value as readonly T[]) : [value as T];
}

function matchesScope(allowedScopes: ReadonlySet<Scope> | null, scope: Scope | null): boolean {
  return !allowedScopes || (scope !== null && allowedScopes.has(scope));
}

function createTrackingScope(): Scope {
  return {
    values: new Map(),
    handlers: new Map(),
  };
}
