import { afterEach, describe, expect, it } from "vitest";
import { reaction, scope, scoped, store } from "../../lib";
import { withTransaction, writeTransactionStore } from "../../lib/internal";
import { flush, resetActiveScope } from "../support/scope-helpers";
import { makeTarget, resetTransactions } from "../support/transaction-target";

afterEach(resetActiveScope);
afterEach(resetTransactions);

describe("an empty transaction", () => {
  it("does not throw and returns undefined for an empty body", () => {
    expect(() => withTransaction(() => {})).not.toThrow();
    expect(withTransaction(() => {})).toBeUndefined();
  });

  it("commits and notifies nothing when no store is written", async () => {
    const s = scope();
    const st = store(0);
    const observed: number[] = [];

    reaction({ on: st, run: (value: number) => observed.push(value) });

    withTransaction(() => {
      // Reads only, no writes.
      scoped(s, () => {
        void st.value;
      });
    });

    await flush();

    expect(observed).toEqual([]);
    expect(scoped(s, () => st.value)).toBe(0);
  });
});

describe("a transaction whose only writes are Object.is-equal to current", () => {
  it("fires no notification when a store is written to its current value", async () => {
    const s = scope();
    const st = store(0);
    const observed: number[] = [];

    reaction({ on: st, run: (value: number) => observed.push(value) });

    withTransaction(() => {
      scoped(s, () => {
        st.value = 0; // Object.is-equal to current
        st.value = 0; // still equal
      });
    });

    await flush();

    expect(observed).toEqual([]);
    expect(scoped(s, () => st.value)).toBe(0);
  });

  it("fires nothing across two scopes when every write equals the current value", async () => {
    const a = scope();
    const b = scope();
    const st = store(7);
    const observed: number[] = [];

    reaction({ on: st, run: (value: number) => observed.push(value) });

    withTransaction(() => {
      scoped(a, () => {
        st.value = 7;
      });
      scoped(b, () => {
        st.value = 7;
      });
    });

    await flush();

    expect(observed).toEqual([]);
    expect(scoped(a, () => st.value)).toBe(7);
    expect(scoped(b, () => st.value)).toBe(7);
  });

  it("still runs the commit but suppresses notify for an unchanged (changed:false) target", () => {
    // A fake target reporting changed:false models an equal-valued write: the
    // commit is collected at the transaction boundary, but the notify is skipped.
    const target = makeTarget<number>({ changed: false });

    withTransaction(() => {
      writeTransactionStore(target.target, 1);
      // Nothing committed while the transaction is open.
      expect(target.commits).toEqual([]);
    });

    // Commit ran once at the balancing exit...
    expect(target.commits).toEqual([1]);
    // ...but changed:false suppressed the notification.
    expect(target.notifies).toEqual([]);
  });
});
