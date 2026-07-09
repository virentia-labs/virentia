import { describe, expectTypeOf, it } from "vitest";
import { attach, effect, store } from "../../lib";
import type {
  AttachSourceValue,
  Effect,
  EffectAborted,
  EffectCallArgs,
  EffectCallOptions,
  EffectDone,
  EffectDoneValue,
  EffectFailValue,
  EffectFailed,
  EffectFinally,
  EffectHandler,
  EffectHandlerContext,
  EffectParams,
  EffectVariantConfig,
  EffectVariantParams,
  Event,
  EventCallable,
  Scope,
  Store,
} from "../../lib";

describe("effect types", () => {
  it("infers Params/Done/Fail and default Fail = unknown", () => {
    const fx = effect(async (id: string): Promise<number> => id.length);
    expectTypeOf(fx).toEqualTypeOf<Effect<string, number, unknown>>();

    // explicit Fail parameter.
    const fx2 = effect<string, number, Error>(async () => 1);
    expectTypeOf(fx2).toEqualTypeOf<Effect<string, number, Error>>();

    // void Params, void Done (handler returns nothing).
    const voidFx = effect(() => {});
    expectTypeOf(voidFx).toEqualTypeOf<Effect<void, void, unknown>>();
  });

  it("infers callable arg/return types", () => {
    const fx = effect(async (id: string): Promise<number> => id.length);
    expectTypeOf(fx).parameter(0).toEqualTypeOf<string>();
    expectTypeOf(fx).parameter(1).toEqualTypeOf<EffectCallOptions | undefined>();
    expectTypeOf(fx).returns.toEqualTypeOf<Promise<number>>();
    expectTypeOf(fx).toBeCallableWith("id");
    expectTypeOf(fx).toBeCallableWith("id", { signal: new AbortController().signal });

    // A void-params effect is callable with no argument.
    const voidFx = effect(async () => 1);
    expectTypeOf(voidFx).toBeCallableWith();
    expectTypeOf(voidFx).toBeCallableWith(undefined);
  });

  it("computes EffectCallArgs / EffectCallOptions", () => {
    expectTypeOf<EffectCallArgs<string>>().toEqualTypeOf<[params: string, options?: EffectCallOptions]>();
    expectTypeOf<EffectCallArgs<void>>().toEqualTypeOf<[params: void, options?: EffectCallOptions]>();
    expectTypeOf<EffectCallOptions>().toEqualTypeOf<{ signal?: AbortSignal }>();
  });

  it("infers effect sub-unit channel types", () => {
    const fx = effect(async (id: string): Promise<number> => id.length);
    expectTypeOf(fx.pending).toEqualTypeOf<Store<boolean>>();
    expectTypeOf(fx.inFlight).toEqualTypeOf<Store<number>>();
    expectTypeOf(fx.started).toEqualTypeOf<Event<string>>();
    expectTypeOf(fx.done).toEqualTypeOf<Event<EffectDone<string, number>>>();
    expectTypeOf(fx.doneData).toEqualTypeOf<Event<number>>();
    expectTypeOf(fx.failed).toEqualTypeOf<Event<EffectFailed<string, unknown>>>();
    expectTypeOf(fx.fail).toEqualTypeOf<Event<EffectFailed<string, unknown>>>();
    expectTypeOf(fx.failData).toEqualTypeOf<Event<unknown>>();
    expectTypeOf(fx.aborted).toEqualTypeOf<Event<EffectAborted<string>>>();
    expectTypeOf(fx.finally).toEqualTypeOf<Event<EffectFinally<string, number, unknown>>>();
    expectTypeOf(fx.settled).toEqualTypeOf<Event<EffectFinally<string, number, unknown>>>();
    // `abort` is an EventCallable over `unknown | void` (collapses to unknown).
    expectTypeOf(fx.abort).toEqualTypeOf<EventCallable<unknown>>();

    // explicit Fail threads through fail channels.
    const fx2 = effect<string, number, Error>(async () => 1);
    expectTypeOf(fx2.failData).toEqualTypeOf<Event<Error>>();
    expectTypeOf(fx2.failed).toEqualTypeOf<Event<EffectFailed<string, Error>>>();
  });

  it("computes EffectDone / EffectFailed / EffectAborted / EffectFinally shapes", () => {
    expectTypeOf<EffectDone<string, number>>().toEqualTypeOf<{ params: string; result: number }>();
    expectTypeOf<EffectFailed<string, Error>>().toEqualTypeOf<{ params: string; error: Error }>();
    expectTypeOf<EffectAborted<string>>().toEqualTypeOf<{ params: string; reason: unknown }>();
    expectTypeOf<EffectFinally<string, number, Error>>().toEqualTypeOf<
      | ({ status: "done" } & EffectDone<string, number>)
      | ({ status: "fail" } & EffectFailed<string, Error>)
    >();
  });

  it("computes EffectParams / EffectDoneValue / EffectFailValue extractors", () => {
    type Fx = Effect<string, number, Error>;
    expectTypeOf<EffectParams<Fx>>().toEqualTypeOf<string>();
    expectTypeOf<EffectDoneValue<Fx>>().toEqualTypeOf<number>();
    expectTypeOf<EffectFailValue<Fx>>().toEqualTypeOf<Error>();
    // non-effect input resolves to never.
    expectTypeOf<EffectParams<number>>().toBeNever();
    expectTypeOf<EffectParams<never>>().toBeNever();
  });

  it("computes EffectHandler / EffectHandlerContext", () => {
    expectTypeOf<EffectHandler<string, number>>().toEqualTypeOf<
      (params: string, ctx: EffectHandlerContext) => number | PromiseLike<number>
    >();
    expectTypeOf<EffectHandlerContext>().toEqualTypeOf<{ signal: AbortSignal; scope: Scope }>();
  });

  it("infers effect.variant overloads", () => {
    const fx = effect(async (id: string): Promise<number> => id.length);
    // identity variants keep the same Params.
    expectTypeOf(fx.variant()).toEqualTypeOf<Effect<string, number, unknown>>();
    expectTypeOf(fx.variant("named")).toEqualTypeOf<Effect<string, number, unknown>>();
    // param-mapping variant re-types Params to the Call type.
    expectTypeOf(fx.variant((n: number) => String(n))).toEqualTypeOf<Effect<number, number, unknown>>();
    expectTypeOf(fx.variant("named", (n: number) => String(n))).toEqualTypeOf<
      Effect<number, number, unknown>
    >();
    expectTypeOf(
      fx.variant({ params: (arg: { id: number }) => String(arg.id) }),
    ).toEqualTypeOf<Effect<{ id: number }, number, unknown>>();

    expectTypeOf<EffectVariantParams<number, string>>().toEqualTypeOf<(call: number) => string>();
    expectTypeOf<EffectVariantConfig<number, string>>().toMatchTypeOf<{
      params: (call: number) => string;
    }>();
  });

  it("accepts a generic params type at the call site", () => {
    function callWithGenericParams<A, B>(fx: Effect<A | B, void>, payload: A | B) {
      return fx(payload);
    }

    expectTypeOf(callWithGenericParams).toBeFunction();
    expectTypeOf(effect(async () => undefined)).toBeCallableWith();
    expectTypeOf(effect(async (n: number) => n)).toBeCallableWith(5);
  });

  it("extracts Params, Done, Fail from an effect and its param variant", () => {
    const fx = effect<{ id: number }, string, Error>(async (params) => `item:${params.id}`);
    const paramVariant = fx.variant((text: string) => ({ id: Number(text) }));

    expectTypeOf<EffectParams<typeof fx>>().toEqualTypeOf<{ id: number }>();
    expectTypeOf<EffectDoneValue<typeof fx>>().toEqualTypeOf<string>();
    expectTypeOf<EffectFailValue<typeof fx>>().toEqualTypeOf<Error>();
    expectTypeOf<EffectParams<typeof paramVariant>>().toEqualTypeOf<string>();
    expectTypeOf<EffectDoneValue<typeof paramVariant>>().toEqualTypeOf<string>();
  });

  it("types void call args as optional and non-void params as required", () => {
    const voidFx = effect(async () => undefined);
    const numberFx = effect(async (value: number) => value);

    expectTypeOf(voidFx).toBeCallableWith();
    expectTypeOf(numberFx).toBeCallableWith(5);
    expectTypeOf<EffectCallArgs<number>>().toEqualTypeOf<
      [params: number, options?: import("../../lib").EffectCallOptions]
    >();
  });
});

describe("attach types", () => {
  it("computes AttachSourceValue over store / tuple / record / non-source", () => {
    expectTypeOf<AttachSourceValue<Store<number>>>().toEqualTypeOf<number>();
    expectTypeOf<
      AttachSourceValue<readonly [Store<number>, Store<string>]>
    >().toEqualTypeOf<readonly [number, string]>();
    expectTypeOf<
      AttachSourceValue<{ a: Store<number>; b: Store<string> }>
    >().toEqualTypeOf<{ a: number; b: string }>();
    // a non-source shape resolves to never.
    expectTypeOf<AttachSourceValue<number>>().toBeNever();
  });

  it("infers attach() return effects across overloads", () => {
    const base = effect(async (id: string): Promise<number> => id.length);

    // wrapping an effect keeps its signature.
    expectTypeOf(attach({ effect: base })).toEqualTypeOf<Effect<string, number, unknown>>();

    // mapParams re-types the outer Params.
    expectTypeOf(
      attach({ effect: base, mapParams: (outer: { id: string }) => outer.id }),
    ).toEqualTypeOf<Effect<{ id: string }, number, unknown>>();

    // with a store source + mapParams.
    const token = store("t");
    expectTypeOf(
      attach({
        source: token,
        effect: base,
        mapParams: (outer: number, src: string) => `${src}:${outer}`,
      }),
    ).toEqualTypeOf<Effect<number, number, unknown>>();

    // inline handler with a source produces an effect over the handler Params.
    expectTypeOf(
      attach({
        source: token,
        effect: (src: string, params: number): Promise<string> => Promise.resolve(`${src}${params}`),
      }),
    ).toEqualTypeOf<Effect<number, string, unknown>>();
  });

  it("infers source, param, and return types across overloads", () => {
    const s1 = store(1);
    const s2 = store("x");
    const baseFx = effect(async (p: { id: number }) => p.id);

    // Tuple source: mapParams' `source` arg is the positional value tuple, and
    // the result Effect is keyed by the AttachedParams of mapParams.
    const tupleAttached = attach({
      source: [s1, s2] as const,
      effect: baseFx,
      mapParams: (p: { id: number }, src: readonly [number, string]) => {
        expectTypeOf(src).toEqualTypeOf<readonly [number, string]>();
        return p;
      },
    });
    expectTypeOf(tupleAttached).toEqualTypeOf<Effect<{ id: number }, number, unknown>>();

    // Single-store source without mapParams: the inline handler's source arg is
    // the scalar store value.
    const scalarAttached = attach({
      source: s1,
      effect: (src: number, _p: number) => src,
    });
    expectTypeOf(scalarAttached).toEqualTypeOf<Effect<number, number, unknown>>();

    // Passthrough: no source, base Effect — params/done/fail preserved.
    const passthrough = attach({ effect: baseFx });
    expectTypeOf(passthrough).toEqualTypeOf<Effect<{ id: number }, number, unknown>>();
  });
});
