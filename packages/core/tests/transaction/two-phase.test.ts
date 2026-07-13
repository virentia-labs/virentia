import { afterEach, describe, expect, it } from "vitest";
import { scope, scoped, store } from "../../lib";
import {
  enterTransaction,
  exitTransaction,
  withTransaction,
  writeTransactionStore,
  type StoreTransactionTarget,
} from "../../lib/internal";
import { makeTarget, resetTransactions } from "../support/transaction-target";

afterEach(resetTransactions);

describe("transaction two-phase commit", () => {
  it("runs every commit before the first notification", () => {
    const s = scope();
    let committedCount = 0;
    const observedAtNotify: number[] = [];

    const a = makeTarget<number>({
      scope: s,
      id: Symbol("a"),
      onCommit: () => {
        committedCount += 1;
      },
      onNotify: () => observedAtNotify.push(committedCount),
    });
    const b = makeTarget<number>({
      scope: s,
      id: Symbol("b"),
      onCommit: () => {
        committedCount += 1;
      },
      onNotify: () => observedAtNotify.push(committedCount),
    });

    enterTransaction();
    writeTransactionStore(a.target, 1);
    writeTransactionStore(b.target, 2);
    exitTransaction();

    // Both notifies observed the full committed count (2), proving all commits
    // preceded any notify.
    expect(observedAtNotify).toEqual([2, 2]);
  });

  it("notifies in commit-collection order, skipping unchanged targets", () => {
    const s = scope();
    const order: string[] = [];

    const t1 = makeTarget<number>({
      scope: s,
      id: Symbol("t1"),
      changed: true,
      onNotify: () => order.push("T1"),
    });
    const t2 = makeTarget<number>({
      scope: s,
      id: Symbol("t2"),
      changed: false,
      onNotify: () => order.push("T2"),
    });
    const t3 = makeTarget<number>({
      scope: s,
      id: Symbol("t3"),
      changed: true,
      onNotify: () => order.push("T3"),
    });

    enterTransaction();
    writeTransactionStore(t1.target, 1);
    writeTransactionStore(t2.target, 2);
    writeTransactionStore(t3.target, 3);
    exitTransaction();

    expect(order).toEqual(["T1", "T3"]);
  });

  // Atomicity (bug #6, fixed). A commit that throws rolls the whole transaction
  // back so nothing applies; a subscriber that throws during the notify phase does
  // not stop the other subscribers, and the state stays applied.
  describe("atomicity", () => {
    it("rolls back every committed store when a later commit throws", () => {
      const s = scope();
      const st = store(1);
      const throwing: StoreTransactionTarget<number> = {
        scope: s,
        id: Symbol("boom"),
        commit() {
          throw new Error("commit failed");
        },
      };

      scoped(s, () => {
        st.value = 5;
      });

      enterTransaction();
      scoped(s, () => {
        st.value = 9; // joins the open transaction, committed before `throwing`
      });
      writeTransactionStore(throwing, 0);

      expect(() => exitTransaction()).toThrowError("commit failed");

      // The store's commit was reverted — the transaction did not apply.
      scoped(s, () => expect(st.value).toBe(5));
    });

    it("contains a throwing subscriber, still notifying the rest and keeping state applied", () => {
      const s = scope();
      const st1 = store(0);
      const st2 = store(0);
      const seen1: number[] = [];
      const seen2: number[] = [];

      st1.subscribe((value) => {
        seen1.push(value);
        throw new Error("notify failed");
      });
      st2.subscribe((value) => {
        seen2.push(value);
      });

      // A throwing subscriber is contained: it does not surface out of the write
      // (which would break the graph mid-commit), and the rest still run.
      expect(() =>
        withTransaction(() => {
          scoped(s, () => {
            st1.value = 1;
            st2.value = 2;
          });
        }),
      ).not.toThrow();

      // The commit phase succeeded, so the state stays applied...
      scoped(s, () => {
        expect(st1.value).toBe(1);
        expect(st2.value).toBe(2);
      });
      // ...and st2's subscriber still ran despite st1's throwing subscriber.
      expect(seen1).toEqual([1]);
      expect(seen2).toEqual([2]);
    });
  });
});
