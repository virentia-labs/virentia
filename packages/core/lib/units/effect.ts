import { node, run } from "../kernel";
import type { Node } from "../kernel";
import { describeNode, linkInspectorNodes, withInspectorMeta } from "../kernel/inspector";
import {
  getActiveScope,
  getScopeHandler,
  requireActiveScope,
  setActiveScope,
} from "../scope/internal";
import { isMicroScope, unwrapMicroScope } from "../scope/micro";
import type { Scope } from "../scope";
import { registerCleanup } from "../graph/owner";
import { event } from "./event";
import type { Event, EventCallable } from "./event";
import { readonlyStore } from "./store";
import type { Store } from "./store";

const effectHandlerRunner = Symbol("virentia.effectHandlerRunner");

export interface EffectHandlerContext {
  signal: AbortSignal;
  scope: Scope;
}

export type EffectHandler<Params, Done> = (
  params: Params,
  ctx: EffectHandlerContext,
) => Done | PromiseLike<Done>;

export interface EffectCallOptions {
  signal?: AbortSignal;
}

export type EffectCallArgs<Params> = [params: Params, options?: EffectCallOptions];

export interface EffectDone<Params, Done> {
  params: Params;
  result: Done;
}

export interface EffectFailed<Params, Fail> {
  params: Params;
  error: Fail;
}

export interface EffectAborted<Params> {
  params: Params;
  reason: unknown;
}

export type EffectFinally<Params, Done, Fail> =
  | ({ status: "done" } & EffectDone<Params, Done>)
  | ({ status: "fail" } & EffectFailed<Params, Fail>);

export type EffectParams<Fx> = Fx extends Effect<infer Params, any, any> ? Params : never;

export type EffectDoneValue<Fx> = Fx extends Effect<any, infer Done, any> ? Done : never;

export type EffectFailValue<Fx> = Fx extends Effect<any, any, infer Fail> ? Fail : never;

export type EffectVariantParams<Call, BaseParams> = (call: Call) => BaseParams;

export interface EffectVariantConfig<Call, BaseParams> {
  name?: string;
  key?: boolean;
  params: EffectVariantParams<Call, BaseParams>;
}

export interface EffectVariantIdentityConfig {
  name?: string;
  key?: boolean;
}

export interface EffectDevtoolsOptions {
  name?: string;
  key?: boolean;
}

export interface Effect<Params, Done, Fail = unknown> {
  (...call: EffectCallArgs<Params>): Promise<Done>;

  readonly node: Node;
  readonly pending: Store<boolean>;
  readonly inFlight: Store<number>;
  readonly started: Event<Params>;
  readonly done: Event<EffectDone<Params, Done>>;
  readonly failed: Event<EffectFailed<Params, Fail>>;
  readonly fail: Event<EffectFailed<Params, Fail>>;
  readonly doneData: Event<Done>;
  readonly failData: Event<Fail>;
  readonly finally: Event<EffectFinally<Params, Done, Fail>>;
  readonly settled: Event<EffectFinally<Params, Done, Fail>>;
  readonly abort: EventCallable<unknown | void>;
  readonly aborted: Event<EffectAborted<Params>>;

  variant(): Effect<Params, Done, Fail>;
  variant(name: string): Effect<Params, Done, Fail>;
  variant<Call>(params: EffectVariantParams<Call, Params>): Effect<Call, Done, Fail>;
  variant<Call>(name: string, params: EffectVariantParams<Call, Params>): Effect<Call, Done, Fail>;
  variant<Call>(config: EffectVariantConfig<Call, Params>): Effect<Call, Done, Fail>;
  variant(config: EffectVariantIdentityConfig): Effect<Params, Done, Fail>;
}

const effectCallState = Symbol("virentia.effectCallState");

interface EffectCallState<Params, Done> {
  readonly [effectCallState]: true;
  params: Params;
  scope: Scope;
  controller: AbortController;
  completed: boolean;
  resolve(result: Done): void;
  reject(error: unknown): void;
  cleanup(): void;
}

let currentEffectCall: EffectCallState<unknown, unknown> | null = null;

interface EffectInternal<Params, Done> {
  [effectHandlerRunner](params: Params, ctx: EffectHandlerContext): Done | PromiseLike<Done>;
}

type EffectOutcome<Params, Done, Fail> =
  | {
      status: "done";
      call: EffectCallState<Params, Done>;
      params: Params;
      result: Done;
    }
  | {
      status: "fail";
      call: EffectCallState<Params, Done>;
      params: Params;
      error: Fail;
    };

export function effect<Params = void, Done = void, Fail = unknown>(
  handler: EffectHandler<Params, Done>,
  name?: string,
): Effect<Params, Done, Fail>;
export function effect<Params = void, Done = void, Fail = unknown>(
  handler: EffectHandler<Params, Done>,
  devtools?: EffectDevtoolsOptions,
): Effect<Params, Done, Fail>;
export function effect<Params, Done, Fail = unknown>(
  handler: EffectHandler<Params, Done>,
  devtools?: string | EffectDevtoolsOptions,
): Effect<Params, Done, Fail> {
  const options = normalizeDevtoolsOptions(devtools);
  const name = options.name;
  const activeCalls = new Set<EffectCallState<Params, Done>>();
  const inFlightStore = readonlyStore(0, undefined, {
    name: name ? `${name}.inFlight` : undefined,
  });
  const pending = readonlyStore(false, undefined, { name: name ? `${name}.pending` : undefined });
  const started = event<Params>(name ? `${name}.started` : undefined);
  const done = event<EffectDone<Params, Done>>(name ? `${name}.done` : undefined);
  const failed = event<EffectFailed<Params, Fail>>(name ? `${name}.failed` : undefined);
  const doneData = event<Done>(name ? `${name}.doneData` : undefined);
  const failData = event<Fail>(name ? `${name}.failData` : undefined);
  const settled = event<EffectFinally<Params, Done, Fail>>(name ? `${name}.settled` : undefined);
  const aborted = event<EffectAborted<Params>>(name ? `${name}.aborted` : undefined);
  const abortEvent = event<unknown | void>(name ? `${name}.abort` : undefined);
  // Per-scope in-flight counter: a single closure counter would let concurrent
  // calls of this effect in different scopes clobber each other's inFlight/pending.
  const inFlightByScope = new WeakMap<Scope, number>();
  const inFlightOf = (scope: Scope): number => inFlightByScope.get(scope) ?? 0;
  let result: Effect<Params, Done, Fail>;

  const variant: Effect<Params, Done, Fail>["variant"] = ((
    first?: string | EffectVariantIdentityConfig | EffectVariantParams<unknown, Params>,
    second?: EffectVariantParams<unknown, Params>,
  ) => {
    const variantDevtools = resolveVariantDevtools(first);
    const mapParams = resolveVariantParams(first, second);

    return effect<unknown, Done, Fail>((call, ctx) => {
      const params = mapParams ? mapParams(call) : (call as Params);

      return runEffectHandler(result, params, ctx);
    }, variantDevtools);
  }) as Effect<Params, Done, Fail>["variant"];

  const createCall = (
    params: Params,
    options: EffectCallOptions | undefined,
    scope: Scope,
    resolve: (result: Done) => void = noop,
    reject: (error: unknown) => void = noop,
  ): EffectCallState<Params, Done> => {
    const controller = new AbortController();
    const call: EffectCallState<Params, Done> = {
      [effectCallState]: true,
      params,
      scope,
      controller,
      completed: false,
      resolve,
      reject,
      cleanup: () => {},
    };

    if (currentEffectCall) {
      attachAbortSignal(call, currentEffectCall.controller.signal);
    }

    if (options?.signal) {
      attachAbortSignal(call, options.signal);
    }

    return call;
  };

  const setInFlight = (scope: Scope, next: number): void => {
    inFlightByScope.set(scope, next);
    void run({ unit: inFlightStore.node, payload: next, scope });
    void run({ unit: pending.node, payload: next > 0, scope });
  };

  const emitAbort = (call: EffectCallState<Params, Done>, reason: unknown): void => {
    void run({
      unit: aborted.node,
      payload: { params: call.params, reason },
      scope: call.scope,
    });
  };

  // `onlyScope === undefined` aborts every active call (owner-dispose cleanup);
  // a concrete scope aborts only that scope's calls, so a user `fx.abort()` in one
  // scope never cancels an unrelated in-flight call living in another scope.
  const abortActive = (reason?: unknown, onlyScope?: Scope | null): void => {
    for (const call of activeCalls) {
      if (call.completed || call.controller.signal.aborted) continue;
      if (onlyScope !== undefined && call.scope !== onlyScope) continue;

      call.controller.abort(reason);
      emitAbort(call, getAbortReason(call.controller.signal));
    }
  };

  registerCleanup(() => {
    abortActive(new Error("Effect owner disposed"));
  });

  const abort = Object.assign((reason?: unknown) => {
    const scope = getActiveScope();
    const realScope = scope ? unwrapMicroScope(scope) : null;

    // Scope-local: abort only the calls that belong to the scope `abort()` was
    // invoked in (the owner-dispose path above is the only unfiltered sweep).
    abortActive(reason, realScope);

    return realScope
      ? run({ unit: abortEvent.node, payload: reason, scope: realScope })
      : Promise.resolve();
  }, abortEvent) as EventCallable<unknown | void>;

  const executeNode = node({
    meta: withInspectorMeta(undefined, {
      type: "effect.execute",
      name: name ? `${name}.execute` : undefined,
      internal: true,
    }),
    run: (ctx) => {
      const call = ctx.value as EffectCallState<Params, Done>;

      if (call.controller.signal.aborted) {
        return failCall(call, getAbortReason(call.controller.signal) as Fail);
      }

      try {
        const handlerForScope = getScopeHandler(call.scope, result) ?? handler;
        const resultValue = runWithCurrentEffectCall(call, () =>
          handlerForScope(call.params, {
            signal: call.controller.signal,
            scope: call.scope,
          }),
        );

        if (isPromiseLike(resultValue)) {
          return Promise.race([
            Promise.resolve(resultValue).then(
              (done) => doneCall(call, done),
              (error) => failCall(call, error as Fail),
            ),
            waitForAbort(call),
          ]);
        }

        return doneCall(call, resultValue);
      } catch (error) {
        return failCall(call, error as Fail);
      }
    },
  });

  const settleNode = node({
    meta: withInspectorMeta(undefined, {
      type: "effect.settle",
      name: name ? `${name}.settle` : undefined,
      internal: true,
    }),
    run: (ctx) => {
      const outcome = ctx.value as EffectOutcome<Params, Done, Fail>;

      activeCalls.delete(outcome.call);
      outcome.call.cleanup();
      setInFlight(outcome.call.scope, Math.max(0, inFlightOf(outcome.call.scope) - 1));

      if (outcome.status === "done") {
        const finalOutcome = {
          status: "done",
          params: outcome.params,
          result: outcome.result,
        } satisfies EffectFinally<Params, Done, Fail>;

        void done({
          params: outcome.params,
          result: outcome.result,
        });
        void doneData(outcome.result);
        void settled(finalOutcome);
        outcome.call.resolve(outcome.result);
        return finalOutcome;
      }

      const finalOutcome = {
        status: "fail",
        params: outcome.params,
        error: outcome.error,
      } satisfies EffectFinally<Params, Done, Fail>;

      void failed({
        params: outcome.params,
        error: outcome.error,
      });
      void failData(outcome.error);
      void settled(finalOutcome);
      outcome.call.reject(outcome.error);
      return finalOutcome;
    },
  });

  executeNode.next = [settleNode];

  const effectNode = node({
    meta: withInspectorMeta(undefined, {
      type: "effect",
      name,
      key: options.key,
      callable: true,
    }),
    run: (ctx) => {
      if (!ctx.scope) {
        throw new Error("Effect call requires scope");
      }

      const call = isEffectCallState<Params, Done>(ctx.value)
        ? ctx.value
        : createCall(ctx.value as Params, undefined, ctx.scope);

      // A call whose signal was already aborted before it ran never starts:
      // `aborted` has already fired (in createCall), so do NOT emit `started` or
      // bump inFlight — go straight to settling the fail channel (failed /
      // failData / settled) via the execute node.
      if (call.controller.signal.aborted) {
        ctx.launch(executeNode, call);
        return call.params;
      }

      activeCalls.add(call);
      setInFlight(call.scope, inFlightOf(call.scope) + 1);
      void started(call.params);

      // Drive the internal execution with the full call state, but propagate the
      // PARAMS to external observers — a `reaction({ on: effect })` is typed to
      // receive the effect's params, not the internal call object.
      ctx.launch(executeNode, call);

      return call.params;
    },
  });

  linkEffectSubunit("pending", pending.node);
  linkEffectSubunit("inFlight", inFlightStore.node);
  linkEffectSubunit("started", started.node);
  linkEffectSubunit("done", done.node);
  linkEffectSubunit("failed", failed.node);
  linkEffectSubunit("doneData", doneData.node);
  linkEffectSubunit("failData", failData.node);
  linkEffectSubunit("settled", settled.node);
  linkEffectSubunit("abort", abortEvent.node);
  linkEffectSubunit("aborted", aborted.node);

  result = Object.assign(
    (...args: EffectCallArgs<Params>) => {
      const ambient = requireActiveScope(() => `call ${describeNode(effectNode)}`);
      const scope = unwrapMicroScope(ambient);
      const params = args[0] as Params;
      const options = args[1];
      const promise = new Promise<Done>((resolve, reject) => {
        const call = createCall(params, options, scope, resolve, reject);

        void run({ unit: effectNode, payload: call, scope });
      });

      // The awaiter gets the effect's own settle promise, which resolves from
      // inside the drain while the scope is still installed — so `await someFx()`
      // already leaves the caller's real scope in place. A micro-scoped reaction
      // body is the exception: restore the micro-scope so reads after the `await`
      // keep being tracked as dependencies.
      return isMicroScope(ambient) ? promise.finally(() => setActiveScope(ambient)) : promise;
    },
    {
      node: effectNode,
      pending,
      inFlight: inFlightStore,
      started,
      done,
      failed,
      fail: failed,
      doneData,
      failData,
      finally: settled,
      settled,
      abort,
      aborted,
      variant,
    },
  );

  Object.defineProperty(result, effectHandlerRunner, {
    enumerable: false,
    value: handler,
  });

  return result;

  function linkEffectSubunit(role: string, child: Node): void {
    linkInspectorNodes(effectNode, child, {
      kind: "owner",
      role,
    });
  }

  function attachAbortSignal(call: EffectCallState<Params, Done>, signal: AbortSignal): void {
    if (signal === call.controller.signal) {
      return;
    }

    const abortFromParent = () => {
      const reason = getAbortReason(signal);

      if (!call.completed && !call.controller.signal.aborted) {
        call.controller.abort(reason);
        emitAbort(call, reason);
      }
    };

    if (signal.aborted) {
      abortFromParent();
      return;
    }

    signal.addEventListener("abort", abortFromParent, { once: true });
    addCallCleanup(call, () => {
      signal.removeEventListener("abort", abortFromParent);
    });
  }

  function doneCall(
    call: EffectCallState<Params, Done>,
    result: Done,
  ): EffectOutcome<Params, Done, Fail> {
    call.completed = true;

    return {
      status: "done",
      call,
      params: call.params,
      result,
    };
  }

  function failCall(
    call: EffectCallState<Params, Done>,
    error: Fail,
  ): EffectOutcome<Params, Done, Fail> {
    call.completed = true;

    return {
      status: "fail",
      call,
      params: call.params,
      error,
    };
  }

  function waitForAbort(
    call: EffectCallState<Params, Done>,
  ): Promise<EffectOutcome<Params, Done, Fail>> {
    if (call.controller.signal.aborted) {
      return Promise.resolve(failCall(call, getAbortReason(call.controller.signal) as Fail));
    }

    return new Promise((resolve) => {
      const settleAborted = () => {
        resolve(failCall(call, getAbortReason(call.controller.signal) as Fail));
      };

      call.controller.signal.addEventListener("abort", settleAborted, { once: true });
      addCallCleanup(call, () => {
        call.controller.signal.removeEventListener("abort", settleAborted);
      });
    });
  }
}

export function runEffectHandler<Params, Done>(
  effect: Effect<Params, Done, any>,
  params: Params,
  ctx: EffectHandlerContext,
): Done | PromiseLike<Done> {
  const handler =
    getScopeHandler(ctx.scope, effect) ??
    (effect as unknown as EffectInternal<Params, Done>)[effectHandlerRunner];

  return handler(params, ctx);
}

// getAbortReason is called more than once per abort (the rejection and the
// aborted event). Memoize per signal so every caller sees the SAME reason
// object — otherwise the `?? new Error("Effect aborted")` fallback would mint a
// fresh Error each call and the aborted.reason would differ from the rejection.
const abortReasonBySignal = new WeakMap<AbortSignal, unknown>();

function getAbortReason(signal: AbortSignal): unknown {
  if (abortReasonBySignal.has(signal)) {
    return abortReasonBySignal.get(signal);
  }

  const reason = signal.reason ?? new Error("Effect aborted");
  abortReasonBySignal.set(signal, reason);

  return reason;
}

function isEffectCallState<Params, Done>(value: unknown): value is EffectCallState<Params, Done> {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { [effectCallState]?: true })[effectCallState] === true
  );
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") && value !== null && "then" in value
  );
}

function runWithCurrentEffectCall<Params, Done, T>(
  call: EffectCallState<Params, Done>,
  fn: () => T,
): T {
  const previous = currentEffectCall;

  currentEffectCall = call as EffectCallState<unknown, unknown>;

  try {
    return fn();
  } finally {
    currentEffectCall = previous;
  }
}

function addCallCleanup<Params, Done>(
  call: EffectCallState<Params, Done>,
  cleanup: () => void,
): void {
  const previousCleanup = call.cleanup;

  call.cleanup = () => {
    previousCleanup();
    cleanup();
  };
}

function resolveVariantDevtools(
  value?: string | EffectVariantIdentityConfig | EffectVariantParams<unknown, unknown>,
): EffectDevtoolsOptions {
  if (typeof value === "string") return { name: value };
  if (typeof value === "object" && value !== null) {
    return {
      name: value.name,
      key: value.key,
    };
  }

  return {};
}

function normalizeDevtoolsOptions(
  devtools: string | EffectDevtoolsOptions | undefined,
): EffectDevtoolsOptions {
  if (typeof devtools === "string") return { name: devtools };

  return devtools ?? {};
}

function resolveVariantParams<Params>(
  first?: string | EffectVariantIdentityConfig | EffectVariantParams<unknown, Params>,
  second?: EffectVariantParams<unknown, Params>,
): EffectVariantParams<unknown, Params> | undefined {
  if (typeof first === "function") return first as EffectVariantParams<unknown, Params>;
  if (typeof second === "function") return second;
  if (typeof first === "object" && first !== null && "params" in first) {
    return (first as EffectVariantConfig<unknown, Params>).params;
  }

  return undefined;
}

function noop(): void {}
