import { describe, expectTypeOf, it } from "vitest";
import { effect, event, reaction, readonlyReactive, store } from "../../lib";
import type { Node, Reaction, ReactionEffectApi, ReactionRun, Scope } from "../../lib";
import { collectNodes, isTracking, trackNode } from "../../lib/internal";
import { mkNode } from "../support/graph-helpers";

describe("reaction types", () => {
  it("infers run payload from single units", () => {
    const changed = event<{ id: string }>();
    const count = store(0);
    const searchFx = effect(async (query: string) => query.length);

    reaction({
      on: changed,
      run(payload, api) {
        expectTypeOf(payload).toEqualTypeOf<{ id: string }>();
        expectTypeOf(api).toEqualTypeOf<ReactionEffectApi>();
      },
    });
    reaction({
      on: count,
      run(value) {
        expectTypeOf(value).toEqualTypeOf<number>();
      },
    });
    reaction({
      on: searchFx,
      run(query) {
        expectTypeOf(query).toEqualTypeOf<string>();
      },
    });
    reaction({
      on: searchFx.doneData,
      run(result) {
        expectTypeOf(result).toEqualTypeOf<number>();
      },
    });
    reaction({
      on: readonlyReactive({ a: 1 }),
      run(value) {
        expectTypeOf(value).toEqualTypeOf<{ a: number }>();
      },
    });
  });

  it("infers run payload from a tuple of units (union)", () => {
    const changed = event<string>();
    const count = store(0);
    reaction({
      on: [changed, count] as const,
      run(value) {
        expectTypeOf(value).toEqualTypeOf<string | number>();
      },
    });
  });

  it("accepts the auto (no-source) reaction forms", () => {
    expectTypeOf(reaction(() => {})).toEqualTypeOf<Reaction>();
    expectTypeOf(reaction({ run() {} })).toEqualTypeOf<Reaction>();
  });

  it("computes the Reaction handle shape", () => {
    expectTypeOf<Reaction>().toMatchTypeOf<{
      readonly node: Node;
      readonly explicit: boolean;
      dependencies(): readonly Node[];
      stop(): void;
    }>();
    expectTypeOf<ReactionRun<string>>().toEqualTypeOf<
      (payload: string, api: ReactionEffectApi) => void
    >();
    expectTypeOf<ReactionEffectApi>().toEqualTypeOf<{
      readonly scope: Scope;
      readonly signal: AbortSignal;
    }>();
  });

  it("infers run payload from a single on unit", () => {
    const changed = event<{ id: string }>();
    const count = store(0);
    const searchFx = effect(async (query: string) => query.length);

    reaction({
      on: changed,
      run(payload) {
        expectTypeOf(payload).toEqualTypeOf<{ id: string }>();
      },
    });

    reaction({
      on: count,
      run(value) {
        expectTypeOf(value).toEqualTypeOf<number>();
      },
    });

    reaction({
      on: searchFx,
      run(query) {
        expectTypeOf(query).toEqualTypeOf<string>();
      },
    });

    reaction({
      on: searchFx.doneData,
      run(result) {
        expectTypeOf(result).toEqualTypeOf<number>();
      },
    });
  });

  it("infers an arrow handler's payload from a single unit or a unit list", () => {
    const changed = event<string>();
    const count = store(0);

    reaction({
      on: changed,
      run: (value) => {
        expectTypeOf(value).toEqualTypeOf<string>();
      },
    });

    reaction({
      on: [changed, count] as const,
      run(value) {
        expectTypeOf(value).toEqualTypeOf<string | number>();
      },
    });
  });

  it("infers a union payload from an on-list of mixed units", () => {
    const asString = event<string>();
    const asNumber = store<number>(0);
    const fx = effect(async (params: string) => params.length);

    reaction({
      on: [asString, asNumber] as const,
      run(value) {
        expectTypeOf(value).toEqualTypeOf<string | number>();
      },
    });

    reaction({
      on: fx,
      run(params) {
        expectTypeOf(params).toEqualTypeOf<string>();
      },
    });

    reaction({
      on: fx.doneData,
      run(done) {
        expectTypeOf(done).toEqualTypeOf<number>();
      },
    });
  });
});

describe("dependency tracking types", () => {
  it("infers collectNodes' result type from its callback, with nodes typed as Set<Node>", () => {
    const collected = collectNodes(() => "x");
    expectTypeOf(collected.result).toEqualTypeOf<string>();
    expectTypeOf(collected.nodes).toEqualTypeOf<Set<Node>>();
  });

  it("preserves an object-or-union collectNodes result type", () => {
    const collected = collectNodes(() => ({ a: 1 }) as { a: number } | null);
    expectTypeOf(collected.result).toEqualTypeOf<{ a: number } | null>();
  });

  it("give trackNode a void return and isTracking a boolean return", () => {
    const n = mkNode("n");
    expectTypeOf(trackNode(n)).toBeVoid();
    expectTypeOf(isTracking()).toBeBoolean();
  });
});
