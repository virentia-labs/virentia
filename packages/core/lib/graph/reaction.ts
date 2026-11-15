import { runDetached } from "../kernel";
import { registerDirectRun } from "../kernel/run";
import type { KernelExecutionContext, Node } from "../kernel";
import { topologyChanged, topologyShrank } from "../kernel/topology";
import { registerOwnedNode } from "../kernel/create";
import {
  devDiagnostics,
  isInspectorEnabled,
  withDeferredDeclarationSite,
  withInspectorMeta,
} from "../kernel/inspector";
import { getActiveScope, setActiveScope } from "../scope/internal";
import type { Scope } from "../scope";
import { detachScopedDependent, reconcileScopedEdges, reconcileScopedSource } from "../kernel/scoped-edges";
import { createMicroScope, readMicroDependencies, unwrapMicroScope } from "../scope/micro";
import { registerCleanup } from "./owner";
import { trackUnitDeclaration } from "./declaration";
import { boundEventScopeOf } from "../units/event";
import { boundStoreAlive, boundStoreScopeOf, initializeScopedComputed, isNativeStoreUnit } from "../units/binding";
import type { Effect } from "../units/effect";
import type { Event, EventCallable } from "../units/event";
import type { Reactive, ReactiveWritable, Store, StoreWritable } from "../units/store";
import { retainShapes } from "../kernel/shapes";

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

// The api object of one explicit reaction run. `signal` stays an own enumerable
// accessor like an object literal's, but shares one getter: an accessor in a
// literal is defined through the runtime on every run, which costs more than
// the rest of a synchronous reaction run.
const signalAccessor: PropertyDescriptor = {
  get(this: ReactionRunApi): AbortSignal {
    return ReactionRunApi.signalOf(this);
  },
  enumerable: true,
  configurable: true,
};

class ReactionRunApi implements ReactionEffectApi {
  readonly scope: Scope;
  declare readonly signal: AbortSignal;
  #controller: AbortController | null = null;
  readonly #reaction: { runs(): Set<AbortController> };

  constructor(scope: Scope, reaction: { runs(): Set<AbortController> }) {
    this.scope = scope;
    this.#reaction = reaction;
    Object.defineProperty(this, "signal", signalAccessor);
  }

  /** The run's AbortController, created (and registered) on the first read. */
  static signalOf(api: ReactionRunApi): AbortSignal {
    let controller = api.#controller;
    if (!controller) {
      controller = api.#controller = new AbortController();
      api.#reaction.runs().add(controller);
    }
    return controller.signal;
  }

  static controllerOf(api: ReactionRunApi | undefined): AbortController | null {
    return api === undefined ? null : api.#controller;
  }
}
// A run's API lives for that run: keep its hidden class (see kernel/shapes.ts).
retainShapes(
  "core/graph/reaction",
  new ReactionRunApi(
    { values: new Map(), handlers: new Map(), deps: new Map() },
    { runs: () => new Set() },
  ),
);

// Whether a run body can see its second argument, read once from its source.
// It cannot when it declares at most one plain parameter, never names
// `arguments` or `eval`, and is not a sloppy-mode `function` (whose
// `fn.arguments` exposes the call to other code). Anything else keeps its api:
// destructuring, defaults, rest, comments or escapes in the header, computed or
// quoted method keys, bound and native functions, proxies.
const functionSource = Function.prototype.toString;
const PLAIN_HEADER =
  /^(?:[\p{ID_Continue}$\s*]*\(\s*(?:[\p{ID_Start}$_][\p{ID_Continue}$]*\s*)?\)|(?:async\s+)?[\p{ID_Start}$_][\p{ID_Continue}$]*\s*=>)/u;
const SEES_CALL = /\b(?:arguments|eval)\b|\\u|\[native code\]/;

/** @internal Exported for tests. */
export function takesRunApi(run: unknown): boolean {
  if (typeof run !== "function") return true;
  const source = functionSource.call(run);
  return (
    !PLAIN_HEADER.test(source) || SEES_CALL.test(source) || Object.hasOwn(run, "arguments")
  );
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

// Installed by @virentia/core/models around static-model setup runs (§3.4): it
// wraps `run` with the per-instance broadcast router. Null outside those runs.
let reactionConfigTransform:
  | (<C extends { run: (...args: never[]) => unknown }>(config: C) => C)
  | null = null;

/**
 * @internal models-only seam; returns the previous transform for restoration.
 * The wrapped `run` must pass its arguments through: whether a run gets its
 * api is judged on the body as written.
 */
export function setReactionConfigTransform(
  transform: typeof reactionConfigTransform,
): typeof reactionConfigTransform {
  const previous = reactionConfigTransform;

  reactionConfigTransform = transform;

  return previous;
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
  trackUnitDeclaration("reaction");
  // Judged on the first run, so a reaction that never fires pays nothing; a
  // wrapped body is judged now, as written, before the wrapper hides it.
  let takesApi: boolean | undefined;
  if (reactionConfigTransform && typeof input === "object" && "on" in input) {
    takesApi = takesRunApi(input.run);
    input = reactionConfigTransform(input as never) as typeof input;
  }

  const core = registerOwnedNode(new ReactionCore(input, takesApi));

  if (core.explicit) {
    for (const source of toArray((input as ReactionConfig<any, UnitList>).on)) {
      const home = boundStoreSourceScopeOf(source);
      if (home && core.allowed === home) {
        reconcileScopedSource(home, core, source.node);
        (core.boundScopes ??= new Set()).add(home);
        // A scoped computed needs its dependencies in this instance before
        // its first update. Merely filtering a global edge leaves it dormant.
        if (!initializeScopedComputed(source, home)) {
          try { (source as Store<unknown>).value; } catch {}
        }
      } else attach(source.node, core);
      // A scope-less reaction observes globally: let a lazy computed source make
      // its dependency edges global too, so this reaction fires in every scope
      // the dependency changes in — not only where the computed was already read.
      // A scoped reaction keeps the per-scope opt-in and does NOT globalize.
      if (core.allowed === null) {
        source.node.onObserve?.();
      }
      core.dependencies.add(source.node);
    }
  } else {
    // Run the initial auto pass through the kernel (not `runAuto` directly) so an
    // async body's effect `await`s are reentrant — that keeps the ambient
    // micro-scope alive across them, exactly like a later triggered run. A
    // synchronous body still runs synchronously inside this drain.
    //
    // An auto reaction only forms its dynamic per-scope edges by RUNNING in a
    // scope, so the creation pass must run in EVERY configured scope — otherwise a
    // `scope: [a, b]` auto reaction would subscribe (and ever fire) only in `a`.
    const allowed = core.allowed;
    if (allowed === null) runDetached({ unit: core, scope: undefined });
    else if (allowed instanceof Set)
      for (const configuredScope of allowed) runDetached({ unit: core, scope: configuredScope });
    else runDetached({ unit: core, scope: allowed });
  }

  const stop = (): void => core.stop();
  const result: Reaction = {
    node: core,
    explicit: core.explicit,

    dependencies(): readonly Node[] {
      return [...core.dependencies];
    },

    stop,
  };

  registerCleanup(stop);

  return result;
}

/**
 * One reaction: its graph node and everything its runs share. Collections only
 * an async body or a second scope needs are created when one appears.
 */
class ReactionCore implements Node {
  resolveScope: ((scope: Scope) => Scope) | undefined = undefined;
  next: Node[] | undefined = undefined;
  // A shared function, called as this node's method by the kernel.
  run = runReaction as (ctx: KernelExecutionContext) => unknown;
  readonly explicit: boolean;
  readonly handler: (...args: never[]) => unknown;
  /** Whether an explicit body can see the api object (see takesRunApi). */
  takesApi: boolean | undefined;
  /**
   * The scopes it runs in: `null` for a global reaction, else one scope or a
   * Set. Per-scope behavior is opt-in through `scope:` or a scope-bound event
   * view, never inferred from the ambient scope at reaction creation. An
   * explicit scope overrides a bound source's scope; unbound sources stay global.
   */
  readonly allowed: Scope | Set<Scope> | null;
  /** Explicit sources, or a global auto reaction's tracked reads. */
  readonly dependencies = new Set<Node>();
  /** Scopes a scoped auto reaction holds edges in. */
  boundScopes: Set<Scope> | undefined = undefined;
  // Async-body bookkeeping. `inFlight` is the currently-running body per scope
  // (for cancel-previous); `activeRuns` is every live controller (for stop()).
  inFlight: WeakMap<Scope, AbortController> | undefined = undefined;
  activeRuns: Set<AbortController> | undefined = undefined;
  // Latest-wins for async auto reactions: only the most recently started run for
  // a scope is allowed to commit its collected dependencies.
  runTokens: WeakMap<Scope, object> | undefined = undefined;
  stopped = false;
  readonly #name: string | undefined;
  readonly #key: boolean | undefined;
  #meta: Record<string, unknown> | undefined;

  constructor(
    input: (() => unknown) | AutoReactionConfig | ReactionConfig<any, UnitList>,
    takesApi: boolean | undefined,
  ) {
    const config = typeof input === "object" ? input : undefined;
    this.explicit = config !== undefined && "on" in config;
    this.handler =
      config === undefined ? (input as () => unknown) : (config as { run: () => unknown }).run;
    this.takesApi = takesApi;
    this.#name = config?.name;
    this.#key = config?.key;
    const scope = config?.scope;
    const sourceScope = this.explicit
      ? boundSourceScopeOf((config as ReactionConfig<any, UnitList>).on)
      : undefined;
    this.allowed = scope
      ? Array.isArray(scope)
        ? scope.length === 1
          ? scope[0]
          : new Set(scope as readonly Scope[])
        : (scope as Scope)
      : (sourceScope ?? null);
    // The declaration site is captured now, when anything reads it.
    if (isInspectorEnabled() || devDiagnostics) this.#meta = this.createMeta();
  }

  get meta(): Record<string, unknown> {
    return (this.#meta ??= this.createMeta());
  }
  set meta(value: Record<string, unknown>) {
    this.#meta = value;
  }
  private createMeta(): Record<string, unknown> {
    return withDeferredDeclarationSite(
      withInspectorMeta(undefined, {
        type: "reaction",
        name: this.#name,
        key: this.#key,
        internal: false,
      }),
    );
  }

  matches(scope: Scope | null): boolean {
    const allowed = this.allowed;
    if (allowed === null) return true;
    if (scope === null) return false;
    return allowed instanceof Set ? allowed.has(scope) : allowed === scope;
  }

  runs(): Set<AbortController> {
    return (this.activeRuns ??= new Set());
  }

  commitDependencies(realScope: Scope, micro: Scope): void {
    const deps = readMicroDependencies(micro) ?? new Set<Node>();

    if (this.allowed === null) {
      reconcileDependencies(this, this.dependencies, new Set(deps));
    } else {
      reconcileScopedEdges(realScope, this, deps);
      const bound = (this.boundScopes ??= new Set());
      bound.add(realScope);
    }
  }

  // Auto form. A synchronous body reconciles its dependencies immediately; an
  // async body keeps tracking across awaits (micro-scope survives them) and
  // reconciles when it finishes — but only if it is still the latest run for its
  // scope, so a slow earlier run cannot overwrite a newer one's dependencies.
  runAuto(ctxValue: unknown): PromiseLike<unknown> | unknown {
    // A tracked run resolves the real scope and installs a fresh per-run
    // micro-scope as the ambient scope. Because the kernel restores the ambient
    // scope across effect `await`s, this micro-scope keeps collecting the
    // reaction's direct reads even after an `await`. It tracks in the concrete
    // scope the reaction is running in (the firing scope, or a configured scope
    // during the creation pass). A global reaction with no active scope falls
    // back to a throwaway scope — its edges are global anyway.
    const realScope = unwrapMicroScope(getActiveScope()) ?? createTrackingScope();
    const micro = createMicroScope(realScope);
    const previousScope = setActiveScope(micro);
    let result: unknown;

    try {
      result = (this.handler as () => unknown)();
    } finally {
      setActiveScope(previousScope);
    }

    if (!isThenable(result)) {
      this.commitDependencies(realScope, micro);
      return ctxValue;
    }

    return this.settleAuto(result, realScope, micro, ctxValue);
  }

  // The async tail of runAuto, apart so a synchronous run allocates no closures.
  settleAuto(
    result: PromiseLike<unknown>,
    realScope: Scope,
    micro: Scope,
    ctxValue: unknown,
  ): PromiseLike<unknown> {
    const token = {};
    const runTokens = (this.runTokens ??= new WeakMap());
    runTokens.set(realScope, token);

    const commitIfLatest = (): void => {
      // Guard on `stopped`: a parked async auto run must NOT re-attach its
      // dependency edges after `stop()` / owner-dispose, which would resurrect a
      // stopped reaction onto its sources (a leak that defeats GC).
      if (!this.stopped && runTokens.get(realScope) === token) {
        this.commitDependencies(realScope, micro);
      }
    };

    return Promise.resolve(result).then(
      () => {
        commitIfLatest();
        return ctxValue;
      },
      (error) => {
        commitIfLatest();

        // A stopped reaction has no owner left to care about its outcome:
        // `stop()`/owner-dispose already detached it, and the rejection is
        // normally just the teardown abort of whatever the body was awaiting.
        if (this.stopped) return ctxValue;

        throw error;
      },
    );
  }

  // Invokes an async-capable body with cancel-previous semantics. A sync body
  // returns `ctxValue` unchanged; an async body returns a promise the drain (and
  // therefore a `scoped(...)` that triggered the reaction) awaits.
  runBody(scope: Scope | null, ctxValue: unknown): PromiseLike<unknown> | unknown {
    const inFlight = this.inFlight;
    if (scope && inFlight && this.activeRuns?.size) {
      inFlight.get(scope)?.abort();
      inFlight.delete(scope);
    }

    // A body that cannot see its api gets none, and so never asks for a signal.
    const takesApi = this.takesApi ?? (this.takesApi = takesRunApi(this.handler));
    const api = takesApi ? new ReactionRunApi(scope as Scope, this) : undefined;
    const result = (this.handler as (value: unknown, api?: ReactionEffectApi) => unknown)(
      ctxValue,
      api,
    );

    if (!isThenable(result)) {
      const controller = ReactionRunApi.controllerOf(api);
      if (controller) {
        this.activeRuns?.delete(controller);
      }

      return ctxValue;
    }

    return this.settleBody(result, api, scope, ctxValue);
  }

  // The async tail of runBody, apart so a synchronous run allocates no closures.
  settleBody(
    result: PromiseLike<unknown>,
    api: ReactionRunApi | undefined,
    scope: Scope | null,
    ctxValue: unknown,
  ): PromiseLike<unknown> {
    const started = ReactionRunApi.controllerOf(api);
    if (scope && started) {
      (this.inFlight ??= new WeakMap()).set(scope, started);
    }

    const settle = (): void => {
      // The body may have asked for its signal only after it started waiting.
      const controller = ReactionRunApi.controllerOf(api);
      if (controller) {
        this.activeRuns?.delete(controller);

        if (scope && this.inFlight?.get(scope) === controller) {
          this.inFlight.delete(scope);
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

        // Same as the auto form: a stopped reaction's parked run settles
        // quietly — its teardown abort is not a failure anyone can act on.
        if (this.stopped) return ctxValue;

        throw error;
      },
    );
  }

  stop(): void {
    this.stopped = true;

    const activeRuns = this.activeRuns;
    if (activeRuns) {
      for (const controller of activeRuns) {
        controller.abort();
      }

      activeRuns.clear();
    }

    const dependencies = this.dependencies;
    for (const dependency of dependencies) {
      detach(dependency, this);
    }

    dependencies.clear();

    const boundScopes = this.boundScopes;
    if (boundScopes) {
      for (const scope of boundScopes) {
        detachScopedDependent(scope, this);
      }

      boundScopes.clear();
    }
  }
}

function runReaction(this: ReactionCore, ctx: KernelExecutionContext): unknown {
  return runReactionIn(this, ctx.scope, ctx.value);
}

// A reaction reads only the scope and the value of its run: its source's
// propagation may run it without an item (see registerDirectRun).
function runReactionIn(node: Node, scope: Scope | null, value: unknown): unknown {
  const reaction = node as ReactionCore;
  if (reaction.stopped || !reaction.matches(scope)) {
    return value;
  }

  if (reaction.explicit) {
    return reaction.runBody(scope, value);
  }

  return reaction.runAuto(value);
}
registerDirectRun(runReaction, runReactionIn);

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
  // A literal keeps the common single-dependent array at capacity 1.
  if (!source.next) source.next = [next];
  else if (!source.next.includes(next)) source.next.push(next);
  else return;
  topologyChanged();
}

function detach(source: Node, next: Node): void {
  if (!source.next) return;

  const index = source.next.indexOf(next);

  if (index >= 0) {
    source.next.splice(index, 1);
    topologyShrank();
  }
}

function toArray<T>(value: T | readonly T[]): readonly T[] {
  return Array.isArray(value) ? (value as readonly T[]) : [value as T];
}

function boundSourceScopeOf(sources: UnitList): Scope | undefined {
  let scope: Scope | undefined;

  for (const source of toArray(sources)) {
    const bound = boundEventScopeOf(source) ?? boundStoreSourceScopeOf(source);
    if (!bound) continue;
    if (scope && scope !== bound) {
      throw new TypeError("[core] reaction sources are bound to different scopes");
    }
    scope = bound;
  }

  return scope;
}

function boundStoreSourceScopeOf(source: SourceUnit<any>): Scope | undefined {
  const scope = typeof source === "object" && source && !isNativeStoreUnit(source) && "subscribe" in source
    ? boundStoreScopeOf(source as { subscribe: Function }) : undefined;
  if (scope && (source as { [boundStoreAlive]?: boolean })[boundStoreAlive] === false)
    throw new Error("[core] Cannot observe a disposed model store");
  return scope;
}

function createTrackingScope(): Scope {
  return {
    values: new Map(),
    handlers: new Map(),
    deps: new Map(),
  };
}
