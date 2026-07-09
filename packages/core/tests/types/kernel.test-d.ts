import { describe, expectTypeOf, it } from "vitest";
import type { KernelContext, Node, RunOptions, Scope } from "../../lib";
import { context, node, run } from "../../lib/internal";
import type { StoreCommitResult, StoreTransactionTarget } from "../../lib/internal";

describe("kernel internal types", () => {
  it("computes Node and RunOptions shapes", () => {
    expectTypeOf<Node>().toMatchTypeOf<{
      id?: PropertyKey;
      next?: Node[];
      meta?: Record<string, unknown>;
    }>();
    expectTypeOf<RunOptions>().toMatchTypeOf<{ unit: Node | readonly Node[] }>();
    expectTypeOf<KernelContext<number>>().toEqualTypeOf<{ id: symbol; value: number }>();
  });

  it("exposes transaction target types from /internal", () => {
    expectTypeOf<StoreCommitResult>().toMatchTypeOf<{ changed: boolean; notify: () => void }>();
    expectTypeOf<StoreTransactionTarget>().toMatchTypeOf<{ id: symbol; scope: Scope }>();
  });

  it("types the run unit option and ctx.launch inputs against Node", () => {
    const single = node(() => undefined);
    const many: readonly Node[] = [single];

    expectTypeOf(run).parameter(0).toMatchTypeOf<{ unit: Node | readonly Node[] }>();

    const C = context<number>();
    node((ctx) => {
      ctx.launch(single);
      ctx.launch(many);
      expectTypeOf(ctx.getContext(C)).toEqualTypeOf<number>();
      // @ts-expect-error a non-Node unit is rejected
      ctx.launch(42);
    });
  });
});
