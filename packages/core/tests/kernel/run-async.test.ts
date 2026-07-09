import { afterEach, describe, expect, it } from "vitest";
import { event, getCurrentScope, reaction, scope, scoped, store } from "../../lib";
import {
  getActiveScope,
  node,
  run,
  setActiveScope,
  writeTransactionStore,
} from "../../lib/internal";
import type { StoreCommitResult } from "../../lib/internal";
import type { KernelExecutionContext } from "../../lib/kernel/types";
import type { Scope } from "../../lib/scope";
import { reconcileScopedEdges } from "../../lib/kernel/scoped-edges";
import { gate, makeTarget, tick } from "../support/kernel-node";

describe("kernel async run", () => {
  // Reset the ambient scope after every test so a manual setActiveScope() or an
  // async tail's neutral reset never leaks into the next test.
  const reset = (): void => void setActiveScope(null);

  afterEach(reset);

  describe("an async body that resolves", () => {
    it("passes its resolved value downstream as ctx.value", async () => {
      const s = scope();
      let downstreamValue: unknown;
      let downstreamFailed: unknown;
      const downstream = node((ctx) => {
        downstreamValue = ctx.value;
        downstreamFailed = ctx.failed;
      });
      const source = node({
        run: async () => "done",
        next: [downstream],
      });

      await run({ unit: source, scope: s });
      expect(downstreamValue).toBe("done");
      expect(downstreamFailed).toBe(false);
      reset();
    });

    it("flushes a pre-await store write before it resumes", async () => {
      const s = scope();
      const order: string[] = [];
      const target = makeTarget(s, {
        onNotify: () => order.push("notify"),
      });
      // commit records into makeTarget's default array; hook order via a wrapper.
      const wrapped = {
        id: target.id,
        scope: s,
        commit(value: unknown): StoreCommitResult {
          order.push("commit");
          return target.commit(value);
        },
      };
      const asyncNode = node(async () => {
        writeTransactionStore(wrapped, 1);
        order.push("before-await");
        await tick();
        order.push("after-await");
      });

      await run({ unit: asyncNode, scope: s });
      expect(order).toEqual(["before-await", "commit", "notify", "after-await"]);
      reset();
    });
  });

  describe("an async rejection", () => {
    it("marks the node's ctx failed with the thrown error", async () => {
      const s = scope();
      const err = new Error("e");
      let cap!: KernelExecutionContext;
      const failing = node(async (ctx) => {
        cap = ctx;
        throw err;
      });

      await run({ unit: failing, scope: s });
      expect(cap.value).toBeUndefined();
      expect(cap.error).toBe(err);
      expect(cap.failed).toBe(true);
      reset();
    });

    // KNOWN BUG #7 (reported, prod NOT changed): an async rejection is swallowed —
    // downstream still runs with failed=false and run() resolves, whereas a SYNC
    // throw halts and rejects run(). Whether this async/sync asymmetry is a defect
    // or intentional fire-and-forget design is a contract decision, so this stays a
    // characterization of current behavior rather than an it.fails. See Phase 0 report.
    it("still propagates downstream with value, error, and failed all reset", async () => {
      const s = scope();
      let dctx!: KernelExecutionContext;
      const downstream = node((ctx) => {
        dctx = ctx;
      });
      const failing = node({
        run: async () => {
          throw new Error("e");
        },
        next: [downstream],
      });

      await run({ unit: failing, scope: s });
      expect(dctx).toBeDefined();
      expect(dctx.value).toBeUndefined();
      expect(dctx.error).toBeUndefined();
      expect(dctx.failed).toBe(false);
      reset();
    });
  });

  describe("the ambient scope", () => {
    it("is neutral during the await but restored for a downstream node", async () => {
      const s = scope();
      let duringAwaitScope: Scope | null = s;
      let downstreamScope: Scope | null | undefined;
      const downstream = node((ctx) => {
        downstreamScope = ctx.scope;
      });
      const asyncNode = node({
        run: async () => {
          await tick();
          duringAwaitScope = getActiveScope();
        },
        next: [downstream],
      });

      await run({ unit: asyncNode, scope: s });
      expect(duringAwaitScope).toBeNull();
      expect(downstreamScope).toBe(s);
      reset();
    });

    it("returns to the caller's synchronously when a top-level drain yields", async () => {
      const sOuter = scope();
      const sInner = scope();
      const asyncNode = node(async () => {
        await tick();
      });

      setActiveScope(sOuter);
      const p = run({ unit: asyncNode, scope: sInner });
      expect(getActiveScope()).toBe(sOuter);
      await p;
      reset();
    });

    it("is left neutral after a fire-and-forget top-level run settles", async () => {
      const s = scope();
      const asyncNode = node(async () => {
        await tick();
      });

      let runPromise!: Promise<void>;
      let insideScope: Scope | null = null;
      scoped(s, () => {
        runPromise = run({ unit: asyncNode });
        insideScope = getCurrentScope();
      });

      expect(insideScope).toBe(s);
      expect(getCurrentScope()).toBeNull();
      await runPromise;
      expect(getCurrentScope()).toBeNull();
      reset();
    });

    it("returns to the caller after a re-entrant async run for the next sync statement", async () => {
      const s = scope();
      let scopeAfterReentrant: Scope | null | undefined;
      const asyncEffect = node(async () => {
        await tick();
      });
      const reactionNode = node((ctx) => {
        void run({ unit: asyncEffect, scope: ctx.scope });
        scopeAfterReentrant = getActiveScope();
      });

      await run({ unit: reactionNode, scope: s });
      expect(scopeAfterReentrant).toBe(s);
      reset();
    });
  });

  describe("a fire-and-forget async effect", () => {
    it("is awaited by the parent drain", async () => {
      const s = scope();
      let flag = false;
      const asyncEffect = node(async () => {
        await tick();
        flag = true;
      });
      const reactionNode = node((ctx) => {
        void run({ unit: asyncEffect, scope: ctx.scope });
      });

      await run({ unit: reactionNode, scope: s });
      expect(flag).toBe(true);
      reset();
    });

    it("is awaited even as the only promise on an empty queue", async () => {
      const s = scope();
      const order: string[] = [];
      const asyncEffect = node(async () => {
        await tick();
        order.push("effect-done");
      });
      const lone = node((ctx) => {
        void run({ unit: asyncEffect, scope: ctx.scope });
        order.push("sync-body-done");
      });

      await run({ unit: lone, scope: s });
      order.push("run-resolved");
      expect(order).toEqual(["sync-body-done", "effect-done", "run-resolved"]);
      reset();
    });

    it("started from a commit-notify is awaited by the active drain it joins", async () => {
      const s = scope();
      let bDone = false;
      const asyncB = node(async () => {
        await tick();
        bDone = true;
      });
      const target = makeTarget(s, {
        onNotify: () => {
          void run({ unit: asyncB, scope: s });
        },
      });
      const driver = node(() => {
        writeTransactionStore(target, 1);
      });

      await run({ unit: driver, scope: s });
      // If the notify's run() had started a *separate* detached drain, the parent
      // would resolve before B's async tail; joining means B is awaited.
      expect(bDone).toBe(true);
      reset();
    });

    // Two async nodes launched fire-and-forget from one sync node; both must be
    // awaited by the parent drain before run() resolves (ordering via gates).
    it("is awaited even when several are launched from one node", async () => {
      const s = scope();
      const done: string[] = [];
      const g1 = gate();
      const g2 = gate();
      const e1 = node(async () => {
        await g1.promise;
        done.push("e1");
      });
      const e2 = node(async () => {
        await g2.promise;
        done.push("e2");
      });
      const driver = node((ctx) => {
        void run({ unit: e1, scope: ctx.scope });
        void run({ unit: e2, scope: ctx.scope });
      });

      const p = run({ unit: driver, scope: s });
      // Open gates out of order to stress Promise.all collection.
      g2.open();
      await tick();
      g1.open();
      await p;
      expect(done.sort()).toEqual(["e1", "e2"]);
      reset();
    });

    // A store write inside a fire-and-forget async reentrant effect. Its commit
    // happens in the effect's own drain. Ensure it commits (not dropped) and the
    // parent awaits it.
    it("commits its store write before the parent run resolves", async () => {
      const s = scope();
      const committed: unknown[] = [];
      const target = makeTarget(s, { committed });
      const g = gate();
      const asyncEffect = node(async () => {
        await g.promise;
        writeTransactionStore(target, 99);
      });
      const driver = node((ctx) => {
        void run({ unit: asyncEffect, scope: ctx.scope });
      });

      const p = run({ unit: driver, scope: s });
      expect(committed).toEqual([]);
      g.open();
      await p;
      expect(committed).toEqual([99]);
      reset();
    });
  });

  describe("a failing or stopping async body", () => {
    // ctx.fail() in an async node body before an await that then RESOLVES. For a
    // sync node fail() halts propagation. Does an async fail() survive resolution?
    it("halts downstream when it calls ctx.fail() before resolving", async () => {
      const s = scope();
      const ran: string[] = [];
      const downstream = node(() => ran.push("downstream"));
      const failing = node({
        run: async (ctx) => {
          ctx.fail("boom");
          await tick();
          return "resolved";
        },
        next: [downstream],
      });

      await run({ unit: failing, scope: s });
      expect(ran).toEqual([]);
      reset();
    });

    // ctx.stop() in an async node body before an await. stop should halt too.
    it("halts downstream when it calls ctx.stop() before resolving", async () => {
      const s = scope();
      const ran: string[] = [];
      const downstream = node(() => ran.push("downstream"));
      const stopping = node({
        run: async (ctx) => {
          ctx.stop();
          await tick();
          return "resolved";
        },
        next: [downstream],
      });

      await run({ unit: stopping, scope: s });
      expect(ran).toEqual([]);
      reset();
    });
  });

  describe("a throw", () => {
    // A downstream sync node throws AFTER an async upstream resolved. The throw
    // must reject the top-level run() promise (not be swallowed).
    it("downstream of an async node rejects the run promise", async () => {
      const s = scope();
      const err = new Error("downstream-boom");
      const downstream = node(() => {
        throw err;
      });
      const asyncUp = node({
        run: async () => "up",
        next: [downstream],
      });

      await expect(run({ unit: asyncUp, scope: s })).rejects.toBe(err);
      reset();
    });

    // ctx.fail() then throw: the throw should win and reject run().
    it("after ctx.fail() still rejects the run promise", async () => {
      const s = scope();
      const err = new Error("thrown-after-fail");
      const ran: string[] = [];
      const downstream = node(() => ran.push("downstream"));
      const n = node({
        run: (ctx) => {
          ctx.fail("failed-first");
          throw err;
        },
        next: [downstream],
      });

      await expect(run({ unit: n, scope: s })).rejects.toBe(err);
      expect(ran).toEqual([]);
      reset();
    });
  });

  describe("shared-transaction atomicity", () => {
    // FIXED (was a confirmed transaction-atomicity bug; regression guard).
    //
    // A sync node writes a store, then fire-and-forget launches an ASYNC reentrant
    // run, then writes the SAME store again -- all within ONE synchronous node body.
    // `currentTransaction` is a single global shared across nested drains
    // (enterTransaction only bumps `depth`). When the async effect reaches its await
    // boundary, processItem calls `commitActiveTransaction()` (run.ts:435) to flush
    // writes-before-await. Previously that unconditionally committed the ENTIRE
    // shared transaction -- including the still-executing parent node's first write
    // -- firing its notify and committing the store TWICE (intermediate 1, then 2).
    //
    // The fix gates that flush on `activeTransactionDepth() <= 1`: a reentrant async
    // node (depth > 1) shares its ancestor's still-open transaction and must NOT
    // commit it. The two writes to the same target now coalesce to a single commit
    // of the final value (committed === [2], one notify).
    it(
      "keeps a nested async run from committing the parent's coalesced write early",
      async () => {
        const s = scope();
        const committed: unknown[] = [];
        const notified: unknown[] = [];
        const target = {
          id: Symbol(),
          scope: s,
          commit(value: unknown): StoreCommitResult {
            committed.push(value);
            return { changed: true, notify: () => notified.push(value) };
          },
        };
        const asyncEffect = node(async () => {
          await tick();
        });
        const driver = node((ctx) => {
          writeTransactionStore(target, 1);
          void run({ unit: asyncEffect, scope: ctx.scope });
          writeTransactionStore(target, 2);
        });

        await run({ unit: driver, scope: s });

        // Coalesced: only the final value commits, and its subscriber is notified once.
        expect(committed).toEqual([2]);
        expect(notified).toEqual([2]);
        reset();
      },
    );

    // The same atomicity bug through the PUBLIC api (no raw nodes): a sync reaction
    // writes a store, fires an event whose reaction is ASYNC, then writes the store
    // again. An observer of the store must see only the final value -- never the
    // leaked intermediate. Companion regression guard for ADV-01.
    it("keeps a reentrant async reaction from leaking a parent's intermediate write", async () => {
      const s = scope();
      const eventA = event<void>();
      const eventB = event<void>();
      const s1 = store(0);
      const observed: number[] = [];

      reaction({
        on: eventB,
        async run() {
          await tick();
        },
      });
      reaction({
        on: eventA,
        run() {
          s1.value = 1;
          eventB(); // reentrant async -> must not flush this transaction early
          s1.value = 2;
        },
      });
      reaction({ on: s1, run: (v) => observed.push(v) });

      await scoped(s, () => eventA());
      await tick();
      await tick();

      expect(observed).toEqual([2]);
      reset();
    });
  });

  describe("a scoped observer", () => {
    // A reaction (scoped observer) triggers a re-entrant run of a node that, in the
    // SAME scope, feeds back to itself would loop; here we test a bounded feedback:
    // observer of A launches A once more via a guard. Ensures the drain does not
    // drop the second firing.
    it("is re-processed when it re-launches into the live drain", async () => {
      const s = scope();
      const ran: string[] = [];
      const a = node((ctx) => {
        ran.push(`a:${String(ctx.value)}`);
      });
      let launched = false;
      const observer = node((ctx) => {
        ran.push("obs");
        if (!launched) {
          launched = true;
          void run({ unit: a, scope: ctx.scope, payload: "again" });
        }
      });
      reconcileScopedEdges(s, observer, [a]);

      await run({ unit: a, scope: s, payload: "first" });
      // a(first) -> obs -> launches a(again) reentrant -> a(again) -> obs again (guarded)
      expect(ran).toEqual(["a:first", "obs", "a:again", "obs"]);
      reset();
    });

    // scope=null (raw kernel) node with a scoped observer registered under a real
    // scope: the null-scope run must NOT fire the scoped observer (getScopedObservers
    // is only consulted when ctx.scope is truthy).
    it("never fires under a null-scope run", async () => {
      const s = scope();
      const ran: string[] = [];
      const a = node(() => ran.push("a"));
      const observer = node(() => ran.push("obs"));
      reconcileScopedEdges(s, observer, [a]);

      await run({ unit: a, scope: null });
      expect(ran).toEqual(["a"]);
      reset();
    });
  });

  describe("an async yield", () => {
    // batchKey re-batching across an async yield: node T has batchKey "k". An async
    // node A precedes it. While A is awaiting, T is still queued. On resume T runs
    // once. Then finishItem re-pushes T via another path with same key -> should run
    // again (key cleared on dequeue).
    it("lets a batched node run exactly once", async () => {
      const s = scope();
      let count = 0;
      const target = node(() => {
        count += 1;
      });
      const asyncNode = node(async () => {
        await tick();
      });
      // Both async and target enqueued in one run with same batchKey; different
      // nodes so no dedup between them. target should run exactly once.
      await run({ unit: [asyncNode, target], scope: s, batchKey: "k" });
      expect(count).toBe(1);
      reset();
    });

    // An async node resolves BETWEEN two sync store writes to different targets in
    // the same scope. The write before the async node should commit at the async
    // boundary; the write after (in a later sync node) commits in the resumed drain.
    it("commits store writes on either side of it in order", async () => {
      const s = scope();
      const order: string[] = [];
      const t1 = {
        id: Symbol(),
        scope: s,
        commit(v: unknown): StoreCommitResult {
          order.push(`commit-t1:${String(v)}`);
          return { changed: true, notify: () => order.push("notify-t1") };
        },
      };
      const t2 = {
        id: Symbol(),
        scope: s,
        commit(v: unknown): StoreCommitResult {
          order.push(`commit-t2:${String(v)}`);
          return { changed: true, notify: () => order.push("notify-t2") };
        },
      };
      const writeBefore = node((ctx) => {
        writeTransactionStore(t1, "a");
        ctx.value = "x";
      });
      const asyncMid = node(async () => {
        await tick();
      });
      const writeAfter = node(() => {
        writeTransactionStore(t2, "b");
      });
      writeBefore.next = [asyncMid];
      asyncMid.next = [writeAfter];

      await run({ unit: writeBefore, scope: s });
      expect(order).toContain("commit-t1:a");
      expect(order).toContain("commit-t2:b");
      // t1 commits at the async boundary, strictly before t2.
      expect(order.indexOf("commit-t1:a")).toBeLessThan(order.indexOf("commit-t2:b"));
      reset();
    });
  });
});
