import { afterEach, describe, expect, it } from "vitest";
import { scope, scoped, store } from "../../lib";
import type { Scope } from "../../lib";
import { flush, resetActiveScope } from "../support/scope-helpers";
import { resetTransactions } from "../support/transaction-target";

afterEach(resetActiveScope);
afterEach(resetTransactions);

describe("a reentrant write during a real store notification inside a scope", () => {
  it("auto-commits the reentrant write to another store in a fresh transaction", async () => {
    const s = scope();
    const a = store(0);
    const b = store(0);
    const bValues: number[] = [];
    let bDuringANotify = -1;

    // When `a` notifies, synchronously write ANOTHER real store `b`. During a
    // plain write's commit the current transaction is already closed, so this
    // reentrant write starts and auto-commits its own fresh transaction.
    a.subscribe((value: number, sc: Scope) => {
      scoped(sc, () => {
        b.value = value + 100;
      });
      // The reentrant write already committed synchronously in its fresh
      // transaction — b reads back the new value here, still inside a's notify.
      bDuringANotify = scoped(sc, () => b.value);
    });
    b.subscribe((value: number) => {
      bValues.push(value);
    });

    scoped(s, () => {
      a.value = 5;
    });

    await flush();

    // The reentrant write auto-committed inside a's notification.
    expect(bDuringANotify).toBe(105);
    // b's own subscriber ran once, with the committed value.
    expect(bValues).toEqual([105]);
    // Final state is consistent in the scope.
    scoped(s, () => {
      expect(a.value).toBe(5);
      expect(b.value).toBe(105);
    });
  });

  it("keeps the reentrant write in the same scope as the triggering notification", async () => {
    const a = scope();
    const b = scope();
    const source = store(0);
    const mirror = store(0);

    // The subscriber writes `mirror` in whichever scope `source` committed in.
    source.subscribe((value: number, sc: Scope) => {
      scoped(sc, () => {
        mirror.value = value;
      });
    });

    // Commit source in scope a.
    scoped(a, () => {
      source.value = 1;
    });
    await flush();

    // Commit source in scope b.
    scoped(b, () => {
      source.value = 2;
    });
    await flush();

    // Each reentrant mirror write landed in the scope of its triggering commit.
    expect(scoped(a, () => mirror.value)).toBe(1);
    expect(scoped(b, () => mirror.value)).toBe(2);
  });

  it("does not lose the original write when a reentrant write fires during its notify", async () => {
    const s = scope();
    const a = store(0);
    const b = store(0);
    let reentrantRuns = 0;

    a.subscribe((value: number, sc: Scope) => {
      // Only mirror once to avoid an intentional infinite chain; b is a different
      // store so this cannot re-trigger `a`.
      reentrantRuns += 1;
      scoped(sc, () => {
        b.value = value * 10;
      });
    });

    scoped(s, () => {
      a.value = 3;
    });
    await flush();

    expect(reentrantRuns).toBe(1);
    // The original a-write stuck AND the reentrant b-write committed.
    scoped(s, () => {
      expect(a.value).toBe(3);
      expect(b.value).toBe(30);
    });
  });
});
