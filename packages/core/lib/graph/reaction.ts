import { node, run } from "../kernel";
import type { Node } from "../kernel";
import { withInspectorMeta } from "../kernel/inspector";
import { getActiveScope, setActiveScope } from "../scope/internal";
import type { Scope } from "../scope";
import { detachScopedDependent, reconcileScopedEdges } from "../kernel/scoped-edges";
import { createMicroScope, readMicroDependencies, unwrapMicroScope } from "../scope/micro";
import { registerCleanup } from "./owner";
import type { Effect } from "../units/effect";
import type { Event, EventCallable } from "../units/event";
import type { Reactive, ReactiveWritable, Store, StoreWritable } from "../units/store";

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
  | Reactive<T>
  | ReactiveWritable<T>
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
      : T extends ReactiveWritable<infer Value>
        ? Value
        : T extends Reactive<infer Value>
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

/**
 * Passed to an async reaction body. `scope` is the scope the reaction fired in —
 * use it for scope-bound work (`scoped(scope, () => fx())`), since the ambient
 * scope is not preserved across a raw `await`. `signal` aborts when the same reaction
 * fires again in this scope (or the reaction is stopped), for cancel-previous
 * (switch) semantics.
 */
export interface ReactionEffectApi {
  readonly scope: Scope;
  readonly signal: AbortSignal;
}

// Returns `void` so both a plain side effect (`v => arr.push(v)`, whose return
// is ignored) and an `async` body (whose `Promise<void>` is accepted by the
// void-return rule) type-check. Async is detected at runtime.
export type ReactionRun<Payload> = (payload: Payload, api: ReactionEffectApi) => void;

export interface ReactionConfig<Payload, On extends UnitList<Payload> = UnitList<Payload>> {
  on: On;
  name?: string;
  key?: boolean;
  scope?: Scope | readonly Scope[];
  run: ReactionRun<Payload>;
}

export interface AutoReactionConfig {
  name?: string;
  key?: boolean;
  scope?: Scope | readonly Scope[];
  run(): void;
}

export function reaction<On extends readonly SourceUnit<any>[]>(config: {
  on: On;
  name?: string;
  key?: boolean;
  scope?: Scope | readonly Scope[];
  run: ReactionRun<SourceInput<On>>;
}): Reaction;
export function reaction<Payload>(
  config: ReactionConfig<Payload, StoreWritable<Payload>>,
): Reaction;
export function reaction<Payload>(config: ReactionConfig<Payload, Store<Payload>>): Reaction;
export function reaction<Payload>(
  config: ReactionConfig<Payload, ReactiveWritable<Payload>>,
): Reaction;
export function reaction<Payload>(config: ReactionConfig<Payload, Reactive<Payload>>): Reaction;
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
  input: (() => unknown) | AutoReactionConfig | ReactionConfig<any, UnitList>,
): Reaction {
  const explicit = typeof input === "object" && "on" in input;
  const runHandler = typeof input === "function" ? input : input.run;
  const name = typeof input === "object" ? input.name : undefined;
  const key = typeof input === "object" ? input.key : undefined;
  const configuredScopes = typeof input === "object" && input.scope ? toArray(input.scope) : null;
  // Per-scope behavior is opt-in through an explicit `scope:` — never inferred
  // from the ambient scope at creation, which is a fragile global we must not
  // depend on. With `scope:` the reaction fires only in those scopes and stores
  // its dynamic edges per scope; without it the reaction is global (fires in any
  // scope its source changed in, with a single dependency set).
  const allowedScopes = configuredScopes ? new Set(configuredScopes) : null;
  const useGlobalEdges = !configuredScopes;
  const currentDependencies = new Set<Node>();
  const boundScopes = new Set<Scope>();
  // Async-body bookkeeping. `inFlight` is the currently-running body per scope
  // (for cancel-previous); `activeRuns` is every live controller (for stop()).
  const inFlight = new WeakMap<Scope, AbortController>();
  const activeRuns = new Set<AbortController>();
  // Latest-wins for async auto reactions: only the most recently started run for
  // a scope is allowed to commit its collected dependencies.
  const runTokens = new WeakMap<Scope, object>();
  let stopped = false;

  const reactionNode = node({
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
        return runBody(ctx.scope, ctx.value, (api) =>
          (runHandler as ReactionRun<unknown>)(ctx.value, api),
        );
      }

      return runAuto(ctx.value);
    },
  });

  // Starts a tracked run: resolves the real scope and installs a fresh per-run
  // micro-scope as the ambient scope. Because the kernel restores the ambient
  // scope across effect `await`s, this micro-scope keeps collecting the reaction's
  // direct reads even after an `await`.
  const beginTracking = (): { micro: Scope; realScope: Scope; previousScope: Scope | null } => {
    // Track in the concrete scope the reaction is running in (the firing scope,
    // or a configured scope during the creation pass). A global reaction with no
    // active scope falls back to a throwaway scope — its edges are global anyway.
    const realScope = unwrapMicroScope(getActiveScope()) ?? createTrackingScope();
    const micro = createMicroScope(realScope);

    return { micro, realScope, previousScope: setActiveScope(micro) };
  };

  const commitDependencies = (realScope: Scope, micro: Scope): void => {
    const deps = readMicroDependencies(micro) ?? new Set<Node>();

    if (useGlobalEdges) {
      reconcileDependencies(reactionNode, currentDependencies, new Set(deps));
    } else {
      reconcileScopedEdges(realScope, reactionNode, deps);
      boundScopes.add(realScope);
    }
  };

  // Auto form. A synchronous body reconciles its dependencies immediately; an
  // async body keeps tracking across awaits (micro-scope survives them) and
  // reconciles when it finishes — but only if it is still the latest run for its
  // scope, so a slow earlier run cannot overwrite a newer one's dependencies.
  const runAuto = (ctxValue: unknown): PromiseLike<unknown> | unknown => {
    const { micro, realScope, previousScope } = beginTracking();
    let result: unknown;

    try {
      result = (runHandler as () => unknown)();
    } finally {
      setActiveScope(previousScope);
    }

    if (!isThenable(result)) {
      commitDependencies(realScope, micro);
      return ctxValue;
    }

    const token = {};
    runTokens.set(realScope, token);

    const commitIfLatest = (): void => {
      if (runTokens.get(realScope) === token) {
        commitDependencies(realScope, micro);
      }
    };

    return Promise.resolve(result).then(
      () => {
        commitIfLatest();
        return ctxValue;
      },
      (error) => {
        commitIfLatest();
        throw error;
      },
    );
  };

  // Invokes an async-capable body with cancel-previous semantics. A sync body
  // returns `ctxValue` unchanged; an async body returns a promise the drain (and
  // therefore a `scoped(...)` that triggered the reaction) awaits.
  const runBody = (
    scope: Scope | null,
    ctxValue: unknown,
    invoke: (api: ReactionEffectApi) => void | PromiseLike<unknown>,
  ): PromiseLike<unknown> | unknown => {
    if (scope) {
      inFlight.get(scope)?.abort();
      inFlight.delete(scope);
    }

    let controller: AbortController | null = null;
    const result = invoke({
      scope: scope as Scope,
      get signal() {
        if (!controller) {
          controller = new AbortController();
          activeRuns.add(controller);
        }

        return controller.signal;
      },
    });

    if (!isThenable(result)) {
      if (controller) {
        activeRuns.delete(controller);
      }

      return ctxValue;
    }

    if (scope && controller) {
      inFlight.set(scope, controller);
    }

    const settle = (): void => {
      if (controller) {
        activeRuns.delete(controller);

        if (scope && inFlight.get(scope) === controller) {
          inFlight.delete(scope);
        }
      }
    };

    return Promise.resolve(result).then(
      () => {
        settle();
        return ctxValue;
      },
      (error) => {
        settle();
        throw error;
      },
    );
  };

  if (explicit) {
    for (const source of toArray(input.on)) {
      attach(source.node, reactionNode);
      currentDependencies.add(source.node);
    }
  } else {
    // Run the initial auto pass through the kernel (not `runAuto` directly) so an
    // async body's effect `await`s are reentrant — that keeps the ambient
    // micro-scope alive across them, exactly like a later triggered run. A
    // synchronous body still runs synchronously inside this drain.
    void run({ unit: reactionNode, scope: configuredScopes?.[0] });
  }

  const result: Reaction = {
    node: reactionNode,
    explicit,

    dependencies(): readonly Node[] {
      return [...currentDependencies];
    },

    stop(): void {
      stopped = true;

      for (const controller of activeRuns) {
        controller.abort();
      }

      activeRuns.clear();

      for (const dependency of currentDependencies) {
        detach(dependency, reactionNode);
      }

      currentDependencies.clear();

      for (const scope of boundScopes) {
        detachScopedDependent(scope, reactionNode);
      }

      boundScopes.clear();
    },
  };

  registerCleanup(() => {
    result.stop();
  });

  return result;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") && value !== null && "then" in value
  );
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
    deps: new Map(),
  };
}
