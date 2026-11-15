import { afterEach, describe, expect, it } from "vitest";
import { scope } from "../../lib";
import {
  node,
  run,
  runDetached,
  setActiveScope,
  writeTransactionStore,
  type KernelExecutionContext,
} from "../../lib/internal";
import { gate, makeTarget } from "../support/kernel-node";

describe("batch collisions across drain boundaries", () => {
  afterEach(() => { setActiveScope(null); });

  it("promotes after an earlier dequeue and preserves independent scope/key slots when a removed slot is requeued", async () => {
    const a = scope(), b = scope();
    const first = Symbol("same"), second = Symbol("same");
    const seen: unknown[] = [];
    let requeued = false;
    const target = node((ctx) => {
      seen.push([ctx.scope === a ? "a" : "b", ctx.value]);
      if (!requeued && ctx.value === "a:first:last") {
        requeued = true;
        // This key was removed before the handler. A new slot must be created;
        // the following call updates that slot without moving it before peers.
        ctx.launch(target, "a:again:first");
        ctx.launch(target, "a:again:last");
      }
    });
    const marker = node(() => { seen.push("marker"); });
    const transaction = makeTarget(a, {
      onNotify() {
        runDetached({ unit: target, scope: a, batchKey: first, payload: "a:first" });
        runDetached({ unit: marker, scope: a, batchKey: first });
        runDetached({ unit: target, scope: a, batchKey: second, payload: "a:second" });
        runDetached({ unit: target, scope: b, batchKey: first, payload: "b:first" });
        runDetached({ unit: target, scope: a, batchKey: first, payload: "a:first:last" });
        runDetached({ unit: target, scope: b, batchKey: first, payload: "b:last" });
      },
    });
    // The driver itself has already been dequeued before the first collision.
    await run({ unit: node(() => writeTransactionStore(transaction, 1)), scope: a, batchKey: "driver" });
    expect(seen).toEqual([
      ["a", "a:first:last"], "marker", ["a", "a:second"],
      ["b", "b:last"], ["a", "a:again:last"],
    ]);
  });

  it("retains collided slots across an async pause and an independent drain", async () => {
    const a = scope(), b = scope();
    const first = Symbol("first"), second = Symbol("second");
    const pause = gate();
    const seen: unknown[] = [];
    const target = node((ctx) => { seen.push([ctx.scope === a ? "a" : "b", ctx.value]); });
    const relay = node((ctx) => { ctx.launch(target, "second:last"); });
    const blocker = node(() => pause.promise);
    const transaction = makeTarget(a, {
      onNotify() {
        runDetached({ unit: blocker, scope: a });
        runDetached({ unit: target, scope: a, batchKey: first, payload: "first" });
        runDetached({ unit: relay, scope: a, batchKey: second });
        runDetached({ unit: target, scope: a, batchKey: second, payload: "second:first" });
      },
    });
    const pending = run({ unit: node(() => writeTransactionStore(transaction, 1)), scope: a });
    try {
      expect(seen).toEqual([]);
      await run({ unit: target, scope: b, batchKey: first, payload: "independent" });
      expect(seen).toEqual([["b", "independent"]]);
    } finally {
      pause.open();
      await pending;
    }
    // The second target was still queued while the relay updated its payload.
    // Removing the entire node entry on the first dequeue would run it twice.
    expect(seen).toEqual([["b", "independent"], ["a", "first"], ["a", "second:last"]]);
  });

  it("recognizes the first scope collision created by an escaping context after await", async () => {
    const a = scope(), b = scope();
    const pause = gate();
    const seen: unknown[] = [];
    const target = node((ctx) => { seen.push([ctx.scope === a ? "a" : "b", ctx.value]); });
    const relay = node((ctx) => { ctx.launch(target, "b:last"); });
    const source = node(async (ctx) => {
      await pause.promise;
      ctx.scope = a;
      ctx.launch(target, "a:first");
      ctx.scope = b;
      ctx.launch(relay);
      ctx.launch(target, "b:first");
      ctx.scope = a;
      ctx.launch(target, "a:last");
    });
    const pending = run({ unit: source, scope: a, batchKey: "shared" });
    pause.open();
    await pending;
    expect(seen).toEqual([["a", "a:last"], ["b", "b:last"]]);
  });

  it("sees a collision introduced by a priority getter while the queue is being extended", async () => {
    const a = scope(), b = scope();
    const seen: unknown[] = [];
    let launcher!: KernelExecutionContext;
    let promoted = false;
    const target = node((ctx) => { seen.push([ctx.scope === a ? "a" : "b", ctx.value]); });
    const relay = node((ctx) => {
      seen.push("relay");
      ctx.launch(target, "b:last");
    });
    const trigger = node(() => { seen.push("trigger"); });
    Object.defineProperty(trigger, "priority", {
      configurable: true,
      get() {
        if (!promoted) {
          promoted = true;
          const previous = launcher.scope;
          try {
            launcher.scope = b;
            launcher.launch(target, "b:first");
            launcher.scope = a;
            launcher.launch(target, "a:last");
          } finally {
            launcher.scope = previous;
          }
        }
        return 0;
      },
    });
    const driver = node((ctx) => {
      launcher = ctx;
      ctx.launch(target, "a:first");
      ctx.scope = b;
      ctx.launch(relay);
      ctx.scope = a;
      ctx.launch(trigger);
    });
    await run({ unit: driver, scope: a, batchKey: "same" });
    expect(promoted).toBe(true);
    expect(seen).toEqual([["a", "a:last"], "relay", ["b", "b:last"], "trigger"]);
  });

  it("keeps a parent's collided slots intact while a handler runs a separate synchronous drain", async () => {
    const a = scope(), b = scope();
    const seen: unknown[] = [];
    const nestedTarget = node((ctx) => { seen.push(ctx.value); });
    const nested = node((ctx) => {
      ctx.launch(nestedTarget, "nested:first");
      ctx.launch(nestedTarget, "nested:last");
    });
    const target = node((ctx) => {
      seen.push(ctx.value);
      if (ctx.value === "outer:a") {
        void run({ unit: nested, scope: a, batchKey: "nested" });
        seen.push("nested:return");
      }
    });
    const relay = node((ctx) => { ctx.launch(target, "outer:b:last"); });
    const transaction = makeTarget(a, {
      onNotify() {
        runDetached({ unit: target, scope: a, batchKey: "outer", payload: "outer:a" });
        runDetached({ unit: relay, scope: b, batchKey: "outer" });
        runDetached({ unit: target, scope: b, batchKey: "outer", payload: "outer:b:first" });
      },
    });
    await run({ unit: node(() => writeTransactionStore(transaction, 1)), scope: a });
    expect(seen).toEqual(["outer:a", "nested:last", "nested:return", "outer:b:last"]);
  });
});
