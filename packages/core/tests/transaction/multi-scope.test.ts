import { afterEach, describe, expect, it } from "vitest";
import { reaction, scope, scoped, store } from "../../lib";
import type { Scope } from "../../lib";
import { withTransaction } from "../../lib/internal";
import { flush, resetActiveScope } from "../support/scope-helpers";
import { resetTransactions } from "../support/transaction-target";

afterEach(resetActiveScope);
afterEach(resetTransactions);

describe("a transaction spanning two scopes", () => {
  it("commits and notifies in both scopes, batched, from one withTransaction", async () => {
    const a = scope();
    const b = scope();
    const st = store(0);
    const fired: Array<{ scope: Scope; value: number }> = [];

    reaction({
      on: st,
      run: (value: number, api) => {
        fired.push({ scope: api.scope, value });
      },
    });

    withTransaction(() => {
      // Two writes per scope: they collapse to one commit per scope, proving the
      // whole thing is a single batched transaction across both scopes.
      scoped(a, () => {
        st.value = 1;
        st.value = 2;
      });
      scoped(b, () => {
        st.value = 10;
        st.value = 20;
      });
    });

    await flush();

    // Each scope's reaction fired exactly once, with that scope's final value.
    expect(fired).toHaveLength(2);
    const byScope = new Map(fired.map((entry) => [entry.scope, entry.value]));
    expect(byScope.get(a)).toBe(2);
    expect(byScope.get(b)).toBe(20);

    // Final committed state is per-scope and consistent.
    expect(scoped(a, () => st.value)).toBe(2);
    expect(scoped(b, () => st.value)).toBe(20);
  });

  it("keeps two distinct stores across two scopes in one batched transaction", async () => {
    const a = scope();
    const b = scope();
    const left = store(0);
    const right = store(0);
    const observed: string[] = [];

    reaction({ on: left, run: (value: number) => observed.push(`left:${value}`) });
    reaction({ on: right, run: (value: number) => observed.push(`right:${value}`) });

    withTransaction(() => {
      scoped(a, () => {
        left.value = 1;
      });
      scoped(b, () => {
        right.value = 2;
      });
    });

    await flush();

    expect(observed.sort()).toEqual(["left:1", "right:2"]);
    expect(scoped(a, () => left.value)).toBe(1);
    expect(scoped(b, () => right.value)).toBe(2);
    // The write to `left` in a did not leak into b, and vice versa.
    expect(scoped(b, () => left.value)).toBe(0);
    expect(scoped(a, () => right.value)).toBe(0);
  });

  it("defers every commit until the outer withTransaction exits", () => {
    const a = scope();
    const b = scope();
    const st = store(0);
    const committedDuring: number[] = [];

    reaction({
      on: st,
      run: () => {
        committedDuring.push(1);
      },
    });

    withTransaction(() => {
      scoped(a, () => {
        st.value = 5;
      });
      scoped(b, () => {
        st.value = 6;
      });
      // Nothing has notified yet — both writes are still pending in the open
      // transaction.
      expect(committedDuring).toEqual([]);
      // Read-your-writes within the still-open transaction, per scope.
      expect(scoped(a, () => st.value)).toBe(5);
      expect(scoped(b, () => st.value)).toBe(6);
    });
  });
});
