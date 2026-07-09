import { afterEach, describe, expect, it } from "vitest";
import { scope } from "../../lib";
import {
  commitActiveTransaction,
  enterTransaction,
  exitTransaction,
  readTransactionStore,
  withTransaction,
  writeTransactionStore,
  type StoreCommitResult,
  type StoreTransactionTarget,
} from "../../lib/internal";
import { isSentinel, makeTarget, resetTransactions } from "../support/transaction-target";

afterEach(resetTransactions);

describe("transaction engine", () => {
  describe("a write outside any transaction", () => {
    it("commits synchronously before the write call returns", () => {
      const { target, commits } = makeTarget<number>();

      writeTransactionStore(target, 7);

      // By the time the call returns the commit has already happened once.
      expect(commits).toEqual([7]);
    });

    it("leaves no pending value behind once its auto-transaction closes", () => {
      const t = makeTarget<number>();

      writeTransactionStore(t.target, 7);

      expect(isSentinel(readTransactionStore(t.scope, t.id))).toBe(true);
    });
  });

  describe("writes inside one open transaction", () => {
    it("defers every commit until the transaction exits, where each runs once", () => {
      const a = makeTarget<number>();
      const b = makeTarget<number>();
      const c = makeTarget<number>();

      enterTransaction();
      writeTransactionStore(a.target, 1);
      writeTransactionStore(b.target, 2);
      writeTransactionStore(c.target, 3);

      // Nothing committed while the transaction is open.
      expect(a.commits).toEqual([]);
      expect(b.commits).toEqual([]);
      expect(c.commits).toEqual([]);

      exitTransaction();

      expect(a.commits).toEqual([1]);
      expect(b.commits).toEqual([2]);
      expect(c.commits).toEqual([3]);
    });

    it("reads back a pending write within the same transaction", () => {
      const t = makeTarget<string>();

      enterTransaction();
      writeTransactionStore(t.target, "x");

      expect(readTransactionStore<string>(t.scope, t.id)).toBe("x");

      exitTransaction();
    });

    it("reads back the latest of several pending writes before any commit", () => {
      const t = makeTarget<string>();

      enterTransaction();
      writeTransactionStore(t.target, "a");
      writeTransactionStore(t.target, "b");

      expect(readTransactionStore<string>(t.scope, t.id)).toBe("b");
      // Still nothing committed at this point.
      expect(t.commits).toEqual([]);

      exitTransaction();
    });

    it("collapses repeated writes to one commit of the last value", () => {
      const t = makeTarget<number>();

      enterTransaction();
      writeTransactionStore(t.target, 1);
      writeTransactionStore(t.target, 2);
      writeTransactionStore(t.target, 3);
      exitTransaction();

      expect(t.commits).toEqual([3]);
    });

    it("keeps a repeated write in its first-write position", () => {
      const s = scope();
      const order: Array<[string, number]> = [];
      const id1 = makeTarget<number>({
        scope: s,
        id: Symbol("id1"),
        onCommit: (v) => order.push(["id1", v]),
      });
      const id2 = makeTarget<number>({
        scope: s,
        id: Symbol("id2"),
        onCommit: (v) => order.push(["id2", v]),
      });

      enterTransaction();
      writeTransactionStore(id1.target, 10); // establishes id1's position (first)
      writeTransactionStore(id2.target, 20);
      writeTransactionStore(id1.target, 99); // overwrites value, keeps position
      exitTransaction();

      // Position from first write (id1 before id2); value from last write (99).
      expect(order).toEqual([
        ["id1", 99],
        ["id2", 20],
      ]);
    });
  });

  describe("withTransaction", () => {
    it("returns the callback result", () => {
      const result = withTransaction(() => 42);
      expect(result).toBe(42);
    });

    it("returns the callback result object by identity", () => {
      const value = { marker: Symbol("id") };
      expect(withTransaction(() => value)).toBe(value);
    });

    it("does not roll back a pending write when the callback throws", () => {
      const t = makeTarget<string>();

      expect(() =>
        withTransaction(() => {
          writeTransactionStore(t.target, "x");
          throw new Error("boom");
        }),
      ).toThrowError("boom");

      // finally-block exitTransaction committed the pending write; there is no rollback.
      expect(t.commits).toEqual(["x"]);
    });

    it("preserves the earliest write when a later write throws before exit", () => {
      const first = makeTarget<string>();

      expect(() =>
        withTransaction(() => {
          writeTransactionStore(first.target, "kept");
          throw new Error("late");
        }),
      ).toThrow();

      expect(first.commits).toEqual(["kept"]);
    });
  });

  describe("reading a store in a transaction", () => {
    it("yields the sentinel when no transaction is active", () => {
      const s = scope();
      const id = Symbol("unwritten");

      const result = readTransactionStore(s, id);
      expect(isSentinel(result)).toBe(true);
    });

    it("yields the sentinel for an unwritten id inside an active transaction", () => {
      const written = makeTarget<number>();
      const otherId = Symbol("other");

      enterTransaction();
      writeTransactionStore(written.target, 1);

      expect(isSentinel(readTransactionStore(written.scope, otherId))).toBe(true);
      // The written id is NOT the sentinel.
      expect(isSentinel(readTransactionStore(written.scope, written.id))).toBe(false);

      exitTransaction();
    });

    it("yields the sentinel for an unwritten scope inside an active transaction", () => {
      const written = makeTarget<number>();
      const foreignScope = scope();

      enterTransaction();
      writeTransactionStore(written.target, 1);

      expect(isSentinel(readTransactionStore(foreignScope, written.id))).toBe(true);

      exitTransaction();
    });

    it("returns a pending undefined rather than the sentinel", () => {
      const t = makeTarget<undefined>();

      enterTransaction();
      writeTransactionStore(t.target, undefined);

      const result = readTransactionStore<undefined>(t.scope, t.id);
      expect(result).toBeUndefined();
      expect(isSentinel(result)).toBe(false);

      exitTransaction();
    });

    it.each<[string, unknown]>([
      ["null", null],
      ["zero", 0],
      ["false", false],
      ["empty string", ""],
      ["NaN", Number.NaN],
    ])("returns a pending falsy %s verbatim rather than the sentinel", (_label, value) => {
      const t = makeTarget<unknown>();

      enterTransaction();
      writeTransactionStore(t.target, value);

      const result = readTransactionStore<unknown>(t.scope, t.id);
      // Object.is handles NaN correctly.
      expect(Object.is(result, value)).toBe(true);
      expect(isSentinel(result)).toBe(false);

      exitTransaction();
    });

    it("returns a stable sentinel identity across independent absent reads", () => {
      const a = readTransactionStore(scope(), Symbol());
      const b = readTransactionStore(scope(), Symbol());
      expect(a).toBe(b);
      expect(isSentinel(a)).toBe(true);
    });
  });

  describe("commitActiveTransaction", () => {
    it("flushes pending writes while keeping the transaction open", () => {
      const a = makeTarget<string>({ id: Symbol("A") });
      const b = makeTarget<string>({ scope: a.scope, id: Symbol("B") });

      enterTransaction();
      writeTransactionStore(a.target, "a");

      commitActiveTransaction();

      // A committed at the flush.
      expect(a.commits).toEqual(["a"]);
      // Its pending write is gone; the transaction is still open but empty.
      expect(isSentinel(readTransactionStore(a.scope, a.id))).toBe(true);

      writeTransactionStore(b.target, "b");
      // B has not committed yet — still inside the (same-depth) open transaction.
      expect(b.commits).toEqual([]);

      exitTransaction();

      // B commits only at the balancing exit; A is not recommitted.
      expect(a.commits).toEqual(["a"]);
      expect(b.commits).toEqual(["b"]);
    });

    it("preserves depth across nesting so the tail commits at the outermost exit", () => {
      const a = makeTarget<string>({ id: Symbol("A") });
      const b = makeTarget<string>({ scope: a.scope, id: Symbol("B") });

      enterTransaction();
      enterTransaction();
      writeTransactionStore(a.target, "a");

      commitActiveTransaction();
      expect(a.commits).toEqual(["a"]);

      writeTransactionStore(b.target, "b");

      exitTransaction(); // depth 2 -> 1, no commit
      expect(b.commits).toEqual([]);

      exitTransaction(); // depth 1 -> 0, commit B
      expect(b.commits).toEqual(["b"]);
    });
  });

  describe("transaction depth", () => {
    it("commits only when the outermost exit brings depth to zero", () => {
      const t = makeTarget<number>();

      enterTransaction();
      enterTransaction();
      writeTransactionStore(t.target, 1);

      exitTransaction(); // depth 2 -> 1
      expect(t.commits).toEqual([]);
      // The write is still pending & readable.
      expect(readTransactionStore<number>(t.scope, t.id)).toBe(1);

      exitTransaction(); // depth 1 -> 0
      expect(t.commits).toEqual([1]);
    });

    it("commits once at the outermost of five nested levels", () => {
      const t = makeTarget<number>();

      for (let i = 0; i < 5; i += 1) enterTransaction();
      writeTransactionStore(t.target, 42);
      for (let i = 0; i < 4; i += 1) {
        exitTransaction();
        expect(t.commits).toEqual([]);
      }
      exitTransaction();
      expect(t.commits).toEqual([42]);
    });

    it("ignores spurious exits that would underflow depth", () => {
      // Two spurious exits with nothing active.
      expect(() => {
        exitTransaction();
        exitTransaction();
      }).not.toThrow();

      const t = makeTarget<number>();
      enterTransaction();
      writeTransactionStore(t.target, 1);
      exitTransaction();

      // Depth was not left negative: the single balanced cycle committed once.
      expect(t.commits).toEqual([1]);
    });

    it("does nothing when committing with no active transaction", () => {
      expect(() => commitActiveTransaction()).not.toThrow();
    });
  });

  describe("commit isolation", () => {
    it("gives each id in a scope its own commit", () => {
      const s = scope();
      const id1 = makeTarget<string>({ scope: s, id: Symbol("id1") });
      const id2 = makeTarget<string>({ scope: s, id: Symbol("id2") });

      enterTransaction();
      writeTransactionStore(id1.target, "one");
      writeTransactionStore(id2.target, "two");
      exitTransaction();

      expect(id1.commits).toEqual(["one"]);
      expect(id2.commits).toEqual(["two"]);
    });

    it("isolates the same id across two scopes", () => {
      const sharedId = Symbol("shared");
      const scope1 = makeTarget<string>({ scope: scope(), id: sharedId });
      const scope2 = makeTarget<string>({ scope: scope(), id: sharedId });

      enterTransaction();
      writeTransactionStore(scope1.target, "A");
      writeTransactionStore(scope2.target, "B");

      // Read-your-writes stays per scope.
      expect(readTransactionStore<string>(scope1.scope, sharedId)).toBe("A");
      expect(readTransactionStore<string>(scope2.scope, sharedId)).toBe("B");

      exitTransaction();

      expect(scope1.commits).toEqual(["A"]);
      expect(scope2.commits).toEqual(["B"]);
    });

    it("commits each of fifty ids in one scope exactly once", () => {
      const s = scope();
      const targets = Array.from({ length: 50 }, (_, i) =>
        makeTarget<number>({ scope: s, id: Symbol(`id${i}`) }),
      );

      enterTransaction();
      targets.forEach((t, i) => writeTransactionStore(t.target, i));
      exitTransaction();

      targets.forEach((t, i) => {
        expect(t.commits).toEqual([i]);
      });
    });
  });

  describe("the changed flag", () => {
    it("suppresses notification when changed is false", () => {
      const suppressed = makeTarget<number>({ id: Symbol("s"), changed: false });
      const fired = makeTarget<number>({ scope: suppressed.scope, id: Symbol("f"), changed: true });

      enterTransaction();
      writeTransactionStore(suppressed.target, 1);
      writeTransactionStore(fired.target, 2);
      exitTransaction();

      // Both commits ran...
      expect(suppressed.commits).toEqual([1]);
      expect(fired.commits).toEqual([2]);
      // ...but only the changed one notified.
      expect(suppressed.notifies).toEqual([]);
      expect(fired.notifies).toEqual([2]);
    });

    it("honors a forced notification even for an equal value", () => {
      // The transaction layer must not second-guess `changed` via its own equality check.
      const t = makeTarget<number>({ commitResult: () => ({ changed: true, notify: notifySpy }) });
      let notified = 0;
      function notifySpy() {
        notified += 1;
      }

      enterTransaction();
      writeTransactionStore(t.target, 5);
      writeTransactionStore(t.target, 5); // same value again
      exitTransaction();

      expect(t.commits).toEqual([5]); // deduped to a single commit
      expect(notified).toBe(1); // forced notify honored
    });
  });

  describe("commit order", () => {
    it("drains a scope fully in id-insertion order before the next scope", () => {
      const scopeA = scope();
      const scopeB = scope();
      const order: string[] = [];

      const bId1 = makeTarget<number>({
        scope: scopeB,
        id: Symbol("b1"),
        onCommit: () => order.push("B.id1"),
      });
      const aId1 = makeTarget<number>({
        scope: scopeA,
        id: Symbol("a1"),
        onCommit: () => order.push("A.id1"),
      });
      const bId2 = makeTarget<number>({
        scope: scopeB,
        id: Symbol("b2"),
        onCommit: () => order.push("B.id2"),
      });

      enterTransaction();
      writeTransactionStore(bId1.target, 1); // scopeB pushed first
      writeTransactionStore(aId1.target, 2); // scopeA pushed second
      writeTransactionStore(bId2.target, 3); // adds to scopeB's existing map
      exitTransaction();

      // scopeB (id1 then id2) fully drained before scopeA.
      expect(order).toEqual(["B.id1", "B.id2", "A.id1"]);
    });
  });

  describe("a write re-triggered from a notification", () => {
    it("auto-commits in a fresh transaction on the exit path", () => {
      const secondary = makeTarget<string>({ id: Symbol("secondary") });
      let secondaryCommitsDuringNotify = -1;

      const primary = makeTarget<string>({
        id: Symbol("primary"),
        onNotify: () => {
          // During exitTransaction's commit, currentTransaction is already null,
          // so this write starts a fresh auto-committing transaction.
          writeTransactionStore(secondary.target, "reentrant");
          secondaryCommitsDuringNotify = secondary.commits.length;
        },
      });

      enterTransaction();
      writeTransactionStore(primary.target, "p");
      exitTransaction();

      // Secondary committed synchronously inside primary's notify.
      expect(secondaryCommitsDuringNotify).toBe(1);
      expect(secondary.commits).toEqual(["reentrant"]);
    });

    it("defers into the open transaction on the commitActiveTransaction path", () => {
      const secondary = makeTarget<string>({ id: Symbol("secondary") });

      const primary = makeTarget<string>({
        id: Symbol("primary"),
        onNotify: () => {
          // During commitActiveTransaction, currentTransaction is the fresh OPEN
          // transaction, so this write is deferred (not auto-committed).
          writeTransactionStore(secondary.target, "deferred");
        },
      });

      enterTransaction();
      writeTransactionStore(primary.target, "p");

      commitActiveTransaction();

      // Primary committed & notified; the reentrant write did NOT commit yet.
      expect(primary.commits).toEqual(["p"]);
      expect(secondary.commits).toEqual([]);
      // It is pending in the still-open transaction (read-your-writes).
      expect(readTransactionStore<string>(secondary.scope, secondary.id)).toBe("deferred");

      exitTransaction();

      // Now it commits at the balancing exit.
      expect(secondary.commits).toEqual(["deferred"]);
    });

    it("chains fresh transactions and converges under a guard", () => {
      const s = scope();
      const id = Symbol("self");
      const N = 5;
      let counter = 0;
      const commitLog: number[] = [];

      const selfTarget: StoreTransactionTarget<number> = {
        id,
        scope: s,
        commit(value: number): StoreCommitResult {
          commitLog.push(value);
          return {
            changed: true,
            notify() {
              if (counter < N) {
                counter += 1;
                // Re-trigger: fresh auto-committing transaction each time.
                writeTransactionStore(selfTarget, counter);
              }
            },
          };
        },
      };

      enterTransaction();
      writeTransactionStore(selfTarget, 0);
      exitTransaction();

      // Initial commit (0) plus N re-triggered commits (1..N), no infinite loop.
      expect(commitLog).toEqual([0, 1, 2, 3, 4, 5]);
      // currentTransaction was cleanly nulled: a fresh read sees the sentinel.
      expect(isSentinel(readTransactionStore(s, id))).toBe(true);
    });
  });

  describe("teardown", () => {
    it("nulls the transaction so the next write starts a fresh one", () => {
      const t1 = makeTarget<number>({ id: Symbol("t1") });

      enterTransaction();
      writeTransactionStore(t1.target, 1);
      exitTransaction();

      // Post-exit read sees the sentinel (state cleanly nulled).
      expect(isSentinel(readTransactionStore(t1.scope, t1.id))).toBe(true);

      // A new write auto-commits immediately in its own fresh transaction.
      const t2 = makeTarget<number>({ id: Symbol("t2") });
      writeTransactionStore(t2.target, 2);
      expect(t2.commits).toEqual([2]);
    });

    it("keeps a transaction-only scope alive across a microtask tick", async () => {
      const t = makeTarget<string>({ scope: scope(), id: Symbol("live") });

      enterTransaction();
      writeTransactionStore(t.target, "kept-alive");

      await Promise.resolve();

      expect(t.commits).toEqual([]);
      exitTransaction();
      expect(t.commits).toEqual(["kept-alive"]);
    });
  });
});
