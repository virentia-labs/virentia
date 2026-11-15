import { afterEach, describe, expect, it } from "vitest";
import { scope } from "../../lib";
import { node, run, setActiveScope } from "../../lib/internal";
import { reconcileScopedEdges } from "../../lib/kernel/scoped-edges";

afterEach(() => {
  setActiveScope(null);
});

describe("internal kernel node priority", () => {
  it("runs lower priorities first and preserves FIFO ties including the default priority", async () => {
    const seen: string[] = [];
    const task = (name: string, priority?: number) =>
      node({ priority, run: () => seen.push(name) });
    await run({
      unit: [
        task("child first", 3),
        task("default first"),
        task("parent first", 1),
        task("default second", 0),
        task("child second", 3),
        task("parent second", 1),
        task("early", -1),
      ],
      scope: scope(),
    });
    expect(seen).toEqual([
      "early",
      "default first",
      "default second",
      "parent first",
      "parent second",
      "child first",
      "child second",
    ]);
  });

  it("orders scoped observers independently of their registration order", async () => {
    const appScope = scope();
    const seen: string[] = [];
    const source = node();
    const child = node({ priority: 5, run: () => seen.push("child") });
    const parent = node({ priority: 2, run: () => seen.push("parent") });
    const derived = node({ run: () => seen.push("derived") });
    reconcileScopedEdges(appScope, child, [source]);
    reconcileScopedEdges(appScope, parent, [source]);
    reconcileScopedEdges(appScope, derived, [source]);
    await run({ unit: source, scope: appScope });
    expect(seen).toEqual(["derived", "parent", "child"]);
  });

  it("runs newly launched and propagated default work before pending positive priorities", async () => {
    const seen: string[] = [];
    const derived = node({ run: () => seen.push("derived") });
    const launched = node({ run: () => seen.push("launched"), next: [derived] });
    const child = node({ priority: 3, run: () => seen.push("child") });
    const sibling = node({ priority: 1, run: () => seen.push("sibling") });
    const parent = node({
      priority: 1,
      run: (ctx) => {
        seen.push("parent");
        ctx.launch([child, launched]);
      },
    });
    await run({ unit: [parent, sibling], scope: scope() });
    expect(seen).toEqual(["parent", "launched", "derived", "sibling", "child"]);
  });

  it("retains a batched node's FIFO slot and latest payload", async () => {
    const seen: Array<[string, unknown]> = [];
    const target = node({ priority: 2, run: (ctx) => seen.push(["target", ctx.payload]) });
    const sibling = node({ priority: 2, run: () => seen.push(["sibling", null]) });
    const first = node((ctx) => ctx.launch(target, "first"));
    const second = node((ctx) => {
      ctx.launch(sibling);
      ctx.launch(target, "last");
    });
    await run({ unit: [first, second], scope: scope(), batchKey: "update" });
    expect(seen).toEqual([
      ["target", "last"],
      ["sibling", null],
    ]);
  });

  it("keeps the ordinary FIFO breadth-first order when no priority is supplied", async () => {
    const seen: string[] = [];
    const descendant = node(() => seen.push("descendant"));
    const first = node({ run: () => seen.push("first"), next: [descendant] });
    const second = node(() => seen.push("second"));
    await run({ unit: [first, second], scope: scope() });
    expect(seen).toEqual(["first", "second", "descendant"]);
  });

  it("honors priorities in reentrant runs without changing their synchronous boundary", async () => {
    const appScope = scope();
    const seen: string[] = [];
    const child = node({ priority: 5, run: () => seen.push("nested child") });
    const parent = node({ priority: 1, run: () => seen.push("nested parent") });
    const outer = node(() => {
      seen.push("outer start");
      void run({ unit: [child, parent], scope: appScope });
      seen.push("outer end");
    });
    await run({ unit: outer, scope: appScope });
    expect(seen).toEqual(["outer start", "nested parent", "nested child", "outer end"]);
  });

  it("retains priority ordering when an asynchronous node resumes propagation", async () => {
    const seen: string[] = [];
    const derived = node(() => seen.push("derived"));
    const child = node({ priority: 5, run: () => seen.push("child") });
    const parent = node({
      priority: 1,
      run: async () => {
        seen.push("parent start");
        await Promise.resolve();
        seen.push("parent end");
      },
      next: [derived],
    });
    await run({ unit: [child, parent], scope: scope() });
    expect(seen).toEqual(["parent start", "parent end", "derived", "child"]);
  });
});
