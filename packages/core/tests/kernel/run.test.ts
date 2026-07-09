import { afterEach, describe, expect, it } from "vitest";
import { scope } from "../../lib";
import {
  context,
  node,
  requireActiveScope,
  run,
  setActiveScope,
  withContexts,
  writeTransactionStore,
} from "../../lib/internal";
import type { KernelExecutionContext, Node } from "../../lib/kernel/types";
import type { Scope } from "../../lib/scope";
import { beginSpawnCollection } from "../../lib/kernel";
import { reconcileScopedEdges } from "../../lib/kernel/scoped-edges";
import { getNodeCallStackTrace } from "../../lib/kernel/call-stack";
import { createMicroScope } from "../../lib/scope/micro";
import { withInspectorMeta } from "../../lib/kernel/inspector";
import { makeTarget, tick } from "../support/kernel-node";

const named = (name: string): Record<string, unknown> => withInspectorMeta(undefined, { name });

describe("kernel run", () => {
  // Reset the ambient scope after every test so a manual setActiveScope() or an
  // async tail's neutral reset never leaks into the next test.
  const reset = (): void => void setActiveScope(null);

  afterEach(reset);

  it("threads each node's return value into the next node as its payload and value", async () => {
    const s = scope();
    const seen: Array<[unknown, unknown]> = [];
    const second = node((ctx) => {
      seen.push([ctx.payload, ctx.value]);
      return `${String(ctx.value)}!`;
    });
    const first = node({
      run: () => "next",
      next: [second],
    });

    await run({ unit: first, payload: "start", scope: s });

    expect(seen).toEqual([["next", "next"]]);
    reset();
  });

  it("stops both its static next edges and its scoped observers on ctx.stop()", async () => {
    const s = scope();
    const ran: string[] = [];
    const staticNext = node(() => ran.push("static"));
    const observer = node(() => ran.push("observer"));
    const source = node({
      run: (ctx) => {
        ran.push("source");
        ctx.stop();
      },
      next: [staticNext],
    });

    reconcileScopedEdges(s, observer, [source]);

    await run({ unit: source, scope: s });

    expect(ran).toEqual(["source"]);
    reset();
  });

  describe("ctx.fail()", () => {
    it("halts propagation without rejecting the run promise", async () => {
      const s = scope();
      const ran: string[] = [];
      let cap!: KernelExecutionContext;
      const downstream = node(() => ran.push("downstream"));
      const source = node({
        run: (ctx) => {
          cap = ctx;
          ctx.fail("boom");
          return "ignored";
        },
        next: [downstream],
      });

      await expect(run({ unit: source, scope: s })).resolves.toBeUndefined();

      expect(ran).toEqual([]);
      expect(cap.failed).toBe(true);
      expect(cap.stopped).toBe(true);
      expect(cap.error).toBe("boom");
      reset();
    });

    it("defaults its error to the current ctx.value when called without an argument", async () => {
      const s = scope();
      let cap!: KernelExecutionContext;
      const source = node((ctx) => {
        cap = ctx;
        ctx.value = 42;
        ctx.fail();
      });

      await run({ unit: source, scope: s, payload: 0 });

      expect(cap.error).toBe(42);
      expect(cap.failed).toBe(true);
      reset();
    });
  });

  describe("a synchronous throw", () => {
    it("rejects the run promise before any downstream node runs", async () => {
      const s = scope();
      const err = new Error("boom-sync");
      const ran: string[] = [];
      const downstream = node(() => ran.push("downstream"));
      const source = node({
        run: () => {
          throw err;
        },
        next: [downstream],
      });

      await expect(run({ unit: source, scope: s })).rejects.toBe(err);
      expect(ran).toEqual([]);
      reset();
    });

    it("also rejects a run joined by a commit-notify", async () => {
      const s = scope();
      const err = new Error("boom-joined");
      const ran: string[] = [];
      let joined!: Promise<unknown>;

      const shouldNotRun = node(() => ran.push("joined-node"));
      // The write commits inside continueDrain's catch (exitTransaction), whose
      // notify fires a re-entrant run() that joins the still-active drain; that
      // joined waiter is then rejected by settleFlushWaiters(true, err).
      const target = makeTarget(s, {
        onNotify: () => {
          joined = run({ unit: shouldNotRun, scope: s }).then(
            () => "resolved",
            (e) => e,
          );
        },
      });
      const source = node({
        run: () => {
          writeTransactionStore(target, 1);
          throw err;
        },
      });

      await expect(run({ unit: source, scope: s })).rejects.toBe(err);
      expect(await joined).toBe(err);
      expect(ran).toEqual([]);
      reset();
    });

    it("leaves a pre-throw store write committed", async () => {
      const s = scope();
      const committed: unknown[] = [];
      const target = makeTarget(s, { changed: false, committed });
      const source = node(() => {
        writeTransactionStore(target, 5);
        throw new Error("x");
      });

      await expect(run({ unit: source, scope: s })).rejects.toThrow("x");
      expect(committed).toEqual([5]);
      reset();
    });
  });

  describe("the enabled gate", () => {
    it("skips a node whose enabled is false", async () => {
      const s = scope();
      const ran: string[] = [];
      const disabled = node({ enabled: false, run: () => ran.push("disabled") });

      await run({ unit: disabled, scope: s });
      expect(ran).toEqual([]);
      reset();
    });

    it("runs a node only when its enabled function returns true", async () => {
      const s = scope();
      const ran: string[] = [];
      const off = node({ enabled: () => false, run: () => ran.push("off") });
      const on = node({ enabled: () => true, run: () => ran.push("on") });

      await run({ unit: off, scope: s });
      await run({ unit: on, scope: s });

      expect(ran).toEqual(["on"]);
      reset();
    });

    it("applies to static next edges", async () => {
      const s = scope();
      const ran: string[] = [];
      const disabledNext = node({ enabled: false, run: () => ran.push("disabled") });
      const enabledNext = node(() => ran.push("enabled"));
      const source = node({ run: () => undefined, next: [disabledNext, enabledNext] });

      await run({ unit: source, scope: s });
      expect(ran).toEqual(["enabled"]);
      reset();
    });

    it("applies to ctx.launch targets", async () => {
      const s = scope();
      const ran: string[] = [];
      const disabled = node({ enabled: () => false, run: () => ran.push("disabled") });
      const launcher = node((ctx) => ctx.launch(disabled));

      await run({ unit: launcher, scope: s });
      expect(ran).toEqual([]);
      reset();
    });
  });

  describe("a shared batch key", () => {
    it("keeps a re-queued node's first slot but its last-written value", async () => {
      const s = scope();
      const order: Array<[string, unknown]> = [];
      const target = node((ctx) => order.push(["target", ctx.value]));
      const marker = node(() => order.push(["marker", "m"]));
      const a = node({ run: () => "A", next: [target] });
      const b = node({ run: () => "B", next: [marker, target] });

      await run({ unit: [a, b], scope: s, batchKey: "k" });

      // target runs exactly once, at the slot `a` enqueued it (before `marker`,
      // which `b` enqueued), but with `b`'s value.
      expect(order).toEqual([
        ["target", "B"],
        ["marker", "m"],
      ]);
      reset();
    });

    it("does not dedupe the same node run in two different scopes", async () => {
      const sA = scope();
      const sB = scope();
      const ranScopes: Array<Scope | null> = [];
      const target = node((ctx) => ranScopes.push(ctx.scope));
      const target2 = node((ctx) => ranScopes.push(ctx.scope));

      // Both re-entrant runs join the active drain (runningNodeDepth===0) and push
      // `target` with the same batchKey but different scopes -> two live queueKeys.
      const target1 = makeTarget(sA, {
        onNotify: () => {
          void run({ unit: target, scope: sA, batchKey: "k" });
          void run({ unit: target, scope: sB, batchKey: "k" });
        },
      });
      const driver = node(() => writeTransactionStore(target1, 1));

      await run({ unit: driver, scope: sA });

      expect(ranScopes).toHaveLength(2);
      expect(ranScopes).toContain(sA);
      expect(ranScopes).toContain(sB);
      void target2;
      reset();
    });

    it("dedupes the same node within a single drain", async () => {
      const s = scope();
      let count = 0;
      const target = node(() => {
        count += 1;
      });
      const t = makeTarget(s, {
        onNotify: () => {
          void run({ unit: target, scope: s, batchKey: "k" });
          void run({ unit: target, scope: s, batchKey: "k" });
        },
      });
      const driver = node(() => writeTransactionStore(t, 1));

      await run({ unit: driver, scope: s });
      expect(count).toBe(1);
      reset();
    });

    it("dedupes null-scope kernel items", async () => {
      let count = 0;
      const target = node(() => {
        count += 1;
      });
      const a = node({ run: () => "a", next: [target] });
      const b = node({ run: () => "b", next: [target] });

      await run({ unit: [a, b], scope: null, batchKey: "k" });
      expect(count).toBe(1);
      reset();
    });

    it("runs a node again after its key is cleared on dequeue", async () => {
      const s = scope();
      let count = 0;
      const a = node(() => {
        count += 1;
      });
      const y = node({ run: () => undefined, next: [a] });
      const x = node({ run: () => undefined, next: [a, y] });

      // x -> a(k), y ; y -> a(k). a is processed (key deleted) then re-enqueued.
      await run({ unit: x, scope: s, batchKey: "k" });
      expect(count).toBe(2);
      reset();
    });

    it("collapses a diamond to one run of the last-settled value", async () => {
      const s = scope();
      const values: unknown[] = [];
      const target = node((ctx) => values.push(ctx.value));
      const b = node({ run: () => "b", next: [target] });
      const c = node({ run: () => "c", next: [target] });
      const a = node({ run: () => "a", next: [b, c] });

      await run({ unit: a, scope: s, batchKey: "k" });
      expect(values).toEqual(["c"]);
      reset();
    });

    it("dedupes two launches that inherit the triggering key", async () => {
      const s = scope();
      let count = 0;
      const target = node(() => {
        count += 1;
      });
      const launcher = node((ctx) => {
        ctx.launch(target);
        ctx.launch(target);
      });

      await run({ unit: launcher, scope: s, batchKey: "k" });
      expect(count).toBe(1);
      reset();
    });
  });

  describe("no batch key", () => {
    it("runs both pushes of the same node", async () => {
      const s = scope();
      let count = 0;
      const target = node(() => {
        count += 1;
      });
      const a = node({ run: () => "a", next: [target] });
      const b = node({ run: () => "b", next: [target] });

      await run({ unit: [a, b], scope: s });
      expect(count).toBe(2);
      reset();
    });

    it("runs both launches of the same node", async () => {
      const s = scope();
      let count = 0;
      const target = node(() => {
        count += 1;
      });
      const launcher = node((ctx) => {
        ctx.launch(target);
        ctx.launch(target);
      });

      await run({ unit: launcher, scope: s });
      expect(count).toBe(2);
      reset();
    });
  });

  describe("the meta object", () => {
    it("carries a mutation by reference to a downstream node", async () => {
      const s = scope();
      let seen: unknown;
      const downstream = node((ctx) => {
        seen = ctx.meta.marker;
      });
      const source = node({
        run: (ctx) => {
          ctx.meta.marker = "set";
        },
        next: [downstream],
      });

      await run({ unit: source, scope: s });
      expect(seen).toBe("set");
      reset();
    });

    it("defaults to a fresh object shared across the chain", async () => {
      const s = scope();
      let firstMeta: unknown;
      let downstreamSaw: unknown;
      const downstream = node((ctx) => {
        downstreamSaw = ctx.meta.x;
      });
      const source = node({
        run: (ctx) => {
          firstMeta = ctx.meta;
          expect(ctx.meta).toBeTypeOf("object");
          expect(ctx.meta).not.toBeNull();
          ctx.meta.x = 1;
        },
        next: [downstream],
      });

      await run({ unit: source, scope: s });
      expect(firstMeta).toBeTypeOf("object");
      expect(downstreamSaw).toBe(1);
      reset();
    });
  });

  describe("a kernel context", () => {
    it("set on an ancestor is visible to a re-entrant run's node", async () => {
      const s = scope();
      const C = context<string>();
      let seen: unknown;
      const inner = node((ctx) => {
        seen = ctx.getContext(C);
      });
      const outer = node((ctx) => {
        void run({ unit: inner, scope: ctx.scope });
      });

      await run({ unit: outer, scope: s, contexts: [C.setup("outer")] });
      expect(seen).toBe("outer");
      reset();
    });

    it("reads back undefined when it was never set", async () => {
      const s = scope();
      const C = context<string>();
      let seen: unknown = "sentinel";
      const n = node((ctx) => {
        seen = ctx.getContext(C);
      });

      await run({ unit: n, scope: s });
      expect(seen).toBeUndefined();
      reset();
    });

    it("set on one run is isolated from a sibling run", async () => {
      const s = scope();
      const C = context<string>();
      let r1: unknown;
      let r2: unknown;
      const down1 = node((ctx) => {
        r1 = ctx.getContext(C);
      });
      const up1 = node({
        run: (ctx) => ctx.setContext(C, "a"),
        next: [down1],
      });
      const run2node = node((ctx) => {
        r2 = ctx.getContext(C);
      });

      await run({ unit: up1, scope: s });
      await run({ unit: run2node, scope: s, contexts: [C.setup("b")] });

      expect(r1).toBe("a");
      expect(r2).toBe("b");
      reset();
    });

    it("set before an await survives the awaited body", async () => {
      const s = scope();
      const C = context<string>();
      let afterAwait: unknown;
      const asyncNode = node(async (ctx) => {
        ctx.setContext(C, "pre");
        await tick();
        afterAwait = ctx.getContext(C);
      });

      await run({ unit: asyncNode, scope: s });
      expect(afterAwait).toBe("pre");
      reset();
    });

    it("provided to withContexts is readable by its getter", () => {
      const single = node(() => undefined);
      const many: readonly Node[] = [single];

      const C = context<number>();
      const probe = node((ctx) => {
        ctx.launch(single);
        ctx.launch(many);
      });

      expect(probe).toBeDefined();
      // withContexts is a real export we exercise for import-surface coverage.
      const value = withContexts([C.setup(5)], () => C.get());
      expect(value).toBe(5);
    });
  });

  describe("ctx.launch", () => {
    it("still runs a target queued before ctx.stop()", async () => {
      const s = scope();
      const ran: string[] = [];
      const b = node(() => ran.push("B"));
      const c = node(() => ran.push("C"));
      const n = node({
        run: (ctx) => {
          ctx.launch(b);
          ctx.stop();
        },
        next: [c],
      });

      await run({ unit: n, scope: s });
      expect(ran).toEqual(["B"]);
      reset();
    });

    it("uses an explicit value over the current ctx.value", async () => {
      const s = scope();
      const seen: unknown[] = [];
      const b = node((ctx) => seen.push(ctx.value));
      const explicit = node((ctx) => {
        ctx.value = "auto";
        ctx.launch(b, "explicit");
      });
      const implicit = node((ctx) => {
        ctx.value = "auto";
        ctx.launch(b);
      });

      await run({ unit: explicit, scope: s });
      await run({ unit: implicit, scope: s });
      expect(seen).toEqual(["explicit", "auto"]);
      reset();
    });

    it("resets its target's failed flag and error even from a failed node", async () => {
      const s = scope();
      let bFailed: unknown;
      let bError: unknown = "sentinel";
      const b = node((ctx) => {
        bFailed = ctx.failed;
        bError = ctx.error;
      });
      const n = node((ctx) => {
        ctx.fail("boom");
        ctx.launch(b);
      });

      await run({ unit: n, scope: s });
      expect(bFailed).toBe(false);
      expect(bError).toBeUndefined();
      reset();
    });
  });

  it("executes an array of units in order over a shared context page", async () => {
    const s = scope();
    const C = context<number>();
    const order: unknown[] = [];
    const u1 = node((ctx) => {
      ctx.setContext(C, 1);
      order.push("u1");
    });
    const u2 = node((ctx) => order.push(["u2", ctx.getContext(C)]));
    const u3 = node((ctx) => order.push(["u3", ctx.getContext(C)]));

    await run({ unit: [u1, u2, u3], scope: s });
    expect(order).toEqual(["u1", ["u2", 1], ["u3", 1]]);
    reset();
  });

  it("assigns an id-less node one implicit id reused across batches", async () => {
    const s = scope();
    const n = node({ run: () => undefined });

    expect(n.id).toBeUndefined();
    await run({ unit: n, scope: s, batchKey: "k1" });
    const firstId = n.id;
    expect(typeof firstId).toBe("number");
    await run({ unit: n, scope: s, batchKey: "k2" });
    expect(n.id).toBe(firstId);
    reset();
  });

  describe("spawn collection", () => {
    it("collects a top-level async run's promise", async () => {
      const s = scope();
      const asyncNode = node(async () => {
        await tick();
      });

      const stop = beginSpawnCollection();
      const p = run({ unit: asyncNode, scope: s });
      const collected = stop();

      expect(collected).toHaveLength(1);
      await Promise.all(collected);
      await p;
      reset();
    });

    it("captures into the innermost sink only", async () => {
      const s = scope();
      const asyncNode = node(async () => {
        await tick();
      });

      const outerStop = beginSpawnCollection();
      const innerStop = beginSpawnCollection();
      const p = run({ unit: asyncNode, scope: s });
      const inner = innerStop();
      const outer = outerStop();

      expect(inner).toHaveLength(1);
      expect(outer).toHaveLength(0);

      // Sink restored to null: a further top-level run is collected by nobody.
      const p2 = run({ unit: asyncNode, scope: s });
      await Promise.all([...inner, ...outer]);
      await p;
      await p2;
      reset();
    });
  });

  it("unwraps a micro-scope option to its real parent scope", async () => {
    const real = scope();
    const micro = createMicroScope(real);
    let seen: Scope | null | undefined;
    const n = node((ctx) => {
      seen = ctx.scope;
    });

    await run({ unit: n, scope: micro });
    expect(seen).toBe(real);
    reset();
  });

  describe("the node call stack", () => {
    it("names the nested A-to-B unit path in the raised diagnostic", async () => {
      // No ambient scope anywhere, so `b`'s requireActiveScope() genuinely fails
      // and the "Scope is required" diagnostic reports the A -> B unit path.
      const b = node({
        meta: named("B"),
        run: () => {
          requireActiveScope(() => "call event");
        },
      });
      let innerPromise!: Promise<unknown>;
      const a = node({
        meta: named("A"),
        run: () => {
          innerPromise = run({ unit: b });
        },
      });

      await run({ unit: a });
      const err = (await innerPromise.catch((e: unknown) => e)) as Error;

      expect(err).toBeInstanceOf(Error);
      expect(err.message).toContain('unit "A"');
      expect(err.message).toContain('unit "B"');
      expect(err.message).toContain('unit "A" → unit "B"');
      reset();
    });

    it("is empty after an async boundary", async () => {
      const s = scope();
      let trace: string[] = ["unset"];
      const n = node(async () => {
        await tick();
        trace = getNodeCallStackTrace();
      });

      await run({ unit: n, scope: s });
      expect(trace).toEqual([]);
      reset();
    });

    it("is empty again after a throw", async () => {
      const s = scope();
      const n = node(() => {
        throw new Error("x");
      });

      await run({ unit: n, scope: s }).catch(() => undefined);
      expect(getNodeCallStackTrace()).toEqual([]);
      reset();
    });
  });
});
