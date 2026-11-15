import { describe, expect, it } from "vitest";
import { scope } from "../../lib";
import {
  context,
  node,
  run,
  runDetached,
  writeTransactionStore,
  reconcileScopedEdges,
} from "../../lib/internal";
import { onInspectorEvent } from "../../lib/kernel/inspector";
import { makeTarget } from "../support/kernel-node";

describe("detached propagation fast path", () => {
  it.each([false, true])(
    "forwards payload, metadata and page through routing nodes (inspected=%s)",
    async (inspected) => {
      const app = scope(),
        other = scope();
      const value = context<number>();
      const payload = { value: 3 },
        meta = { source: "test" };
      const seen: unknown[] = [];
      const terminal = () =>
        node((ctx) => {
          seen.push([ctx.scope, ctx.value, ctx.payload, ctx.meta, ctx.getContext(value)]);
        });
      const route = node({ next: [node({ next: [terminal()] })] });
      reconcileScopedEdges(app, terminal(), [route]);
      reconcileScopedEdges(
        other,
        node(() => {
          throw Error("wrong scope");
        }),
        [route],
      );
      const inspectedNodes: unknown[] = [];
      const off = inspected
        ? onInspectorEvent((event) => {
            if (event.type === "node-start") inspectedNodes.push(event.node);
          })
        : undefined;
      try {
        await run({ unit: route, scope: app, payload, meta, contexts: [value.setup(42)] });
      } finally {
        off?.();
      }
      expect(seen).toEqual(Array.from({ length: 2 }, () => [app, payload, payload, meta, 42]));
      if (inspected) expect(inspectedNodes).toContain(route);
    },
  );

  it("batches by node, real scope and key identity, not stringified IDs", async () => {
    const a = scope(),
      b = scope();
    const first = Symbol("same"),
      second = Symbol("same");
    const seen: unknown[] = [];
    const target = node((ctx) => {
      seen.push([ctx.scope === a ? "a" : "b", ctx.value]);
    });
    const transaction = makeTarget(a, {
      onNotify() {
        runDetached({ unit: target, scope: a, batchKey: first, payload: 1 });
        runDetached({ unit: target, scope: a, batchKey: second, payload: 2 });
        runDetached({ unit: target, scope: b, batchKey: first, payload: 3 });
        runDetached({ unit: target, scope: a, batchKey: first, payload: 4 });
        runDetached({ unit: target, scope: b, batchKey: first, payload: 5 });
      },
    });
    await run({ unit: node(() => writeTransactionStore(transaction, 1)), scope: a });
    expect(seen).toEqual([
      ["a", 4],
      ["a", 2],
      ["b", 5],
    ]);
  });

  it("keeps separate context pages for sibling notifications", async () => {
    const app = scope();
    const value = context<number>();
    const seen: number[] = [];
    const transaction = makeTarget(app, {
      onNotify() {
        runDetached({
          unit: node((ctx) => {
            ctx.setContext(value, 2);
          }),
          scope: app,
        });
        runDetached({
          unit: node((ctx) => {
            seen.push(ctx.getContext(value));
          }),
          scope: app,
        });
      },
    });
    await run({
      unit: node(() => writeTransactionStore(transaction, 1)),
      scope: app,
      contexts: [value.setup(1)],
    });
    expect(seen).toEqual([1]);
  });

  it("still waits for async work launched by detached commit notifications", async () => {
    const app = scope();
    const seen: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const transaction = makeTarget(app, {
      onNotify() {
        runDetached({
          unit: node(async () => {
            await gate;
            seen.push("done");
          }),
          scope: app,
        });
      },
    });
    let settled = false;
    const pending = run({
      unit: node(() => writeTransactionStore(transaction, 1)),
      scope: app,
    }).then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    await pending;
    expect(seen).toEqual(["done"]);
    expect(settled).toBe(true);
  });
});

describe("batched fan-in", () => {
  it("runs a fan-in target once per update with the last payload", async () => {
    const app = scope();
    const seen: unknown[] = [];
    const target = node((ctx) => {
      seen.push(ctx.value);
    });
    const sources = [1, 2, 3].map((value) => node({ run: () => value, next: [target] }));
    const root = node({ next: sources });
    await run({ unit: root, scope: app, batchKey: "k" });
    await run({ unit: root, scope: app, batchKey: "k" });
    expect(seen).toEqual([3, 3]);
  });

  it("keeps coalescing after a drain failed with batched work still queued", async () => {
    const app = scope();
    const seen: unknown[] = [];
    const target = node((ctx) => {
      seen.push(ctx.value);
    });
    const failing = node(() => {
      throw new Error("caller failed");
    });
    // The caller's own failing unit abandons the drain while `target` waits.
    const first = node({ run: () => 1, next: [target] });
    await expect(run({ unit: [first, failing], scope: app, batchKey: "k" })).rejects.toThrow(
      "caller failed",
    );
    const sources = [1, 2].map((value) => node({ run: () => value, next: [target] }));
    await run({ unit: node({ next: sources }), scope: app, batchKey: "k" });
    expect(seen).toEqual([2]);
  });
});
