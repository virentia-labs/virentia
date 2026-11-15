import { afterEach, describe, expect, it } from "vitest";
import { reaction, scope, scoped, store } from "../../lib";
import type { Scope } from "../../lib";
import { readTransactionStore, withTransaction, writeTransactionStore } from "../../lib/internal";
import { copyPendingStoreValues, isPendingStoreValue } from "../../lib/kernel/transaction";
import { nativeStoreStateOf } from "../../lib/units/store";
import { makeTarget, resetTransactions } from "../support/transaction-target";

afterEach(resetTransactions);

const stagedOf = (unit: object): unknown => (unit as { node: { staged?: unknown } }).node.staged;
// A transaction stages a write only when the store is observed: an unobserved
// one commits at once (see "unobserved writes" below).
const observe = (...units: { subscribe(fn: () => void): () => void }[]): (() => void) => {
  const offs = units.map((unit) => unit.subscribe(() => {}));
  return () => offs.forEach((off) => off());
};

describe("native writes staged in a transaction", () => {
  it("publish grouped by scope when writes to two scopes interleave", () => {
    const a = scope(),
      b = scope(),
      x = store(0),
      y = store(0);
    const order: string[] = [];
    const name = (s: Scope) => (s === a ? "a" : "b");
    const offX = x.subscribe((value, s) => order.push(`x${name(s)}=${value}`));
    const offY = y.subscribe((value, s) => order.push(`y${name(s)}=${value}`));
    try {
      withTransaction(() => {
        scoped(a, () => {
          x.value = 1;
        });
        scoped(b, () => {
          x.value = 2;
        });
        scoped(a, () => {
          y.value = 3;
        });
        scoped(b, () => {
          x.value = 4;
        });
      });
      expect(order).toEqual(["xa=1", "ya=3", "xb=4"]);
    } finally {
      offX();
      offY();
    }
  });

  it("reads back each scope's staged value, by store and by id", () => {
    const a = scope(),
      b = scope(),
      x = store(0),
      y = store(0);
    const off = observe(x, y);
    const id = nativeStoreStateOf(x)!.id;
    withTransaction(() => {
      scoped(a, () => {
        x.value = 1;
      });
      scoped(b, () => {
        x.value = 2;
      });
      expect(scoped(a, () => x.value)).toBe(1);
      expect(scoped(b, () => x.value)).toBe(2);
      expect(readTransactionStore(a, id)).toBe(1);
      expect(readTransactionStore(b, id)).toBe(2);
      // Writes after the id lookup built its index stay visible by id.
      scoped(a, () => {
        x.value = 5;
      });
      scoped(b, () => {
        y.value = 6;
      });
      expect(readTransactionStore(a, id)).toBe(5);
      expect(readTransactionStore(b, nativeStoreStateOf(y)!.id)).toBe(6);
      const copied = new Map<unknown, unknown>();
      copyPendingStoreValues(b, copied);
      expect([...copied.values()]).toEqual([2, 6]);
    });
    expect(scoped(a, () => x.value)).toBe(5);
    expect(scoped(b, () => x.value)).toBe(2);
    off();
  });

  it("stages one store in many scopes, like a model field across instances", () => {
    const scopes = Array.from({ length: 20 }, () => scope()),
      x = store(0),
      y = store(0);
    const seen: number[] = [];
    const off = x.subscribe((value) => seen.push(value));
    try {
      withTransaction(() => {
        scopes.forEach((s, index) =>
          scoped(s, () => {
            x.value = index + 1;
            y.value = -index;
          }),
        );
        // Rewrites find each scope's own staged write.
        scopes.forEach((s, index) =>
          scoped(s, () => {
            x.value += 100;
            expect(x.value).toBe(index + 101);
          }),
        );
        expect(readTransactionStore(scopes[7], nativeStoreStateOf(x)!.id)).toBe(108);
      });
      expect(seen).toEqual(scopes.map((_, index) => index + 101));
      expect(scopes.map((s) => scoped(s, () => [x.value, y.value]))).toEqual(
        scopes.map((_, index) => [index + 101, -index]),
      );
    } finally {
      off();
    }
  });

  it("keeps a custom target's place among native writes", () => {
    const app = scope(),
      x = store(0),
      y = store(0);
    const order: string[] = [];
    const custom = makeTarget<number>({ scope: app, onNotify: () => order.push("custom") });
    const offX = x.subscribe(() => order.push("x"));
    const offY = y.subscribe(() => order.push("y"));
    try {
      withTransaction(() => {
        scoped(app, () => {
          x.value = 1;
        });
        writeTransactionStore(custom.target, 1);
        scoped(app, () => {
          y.value = 1;
        });
        // A second write of the custom target only updates its staged value.
        writeTransactionStore(custom.target, 2);
        expect(readTransactionStore(app, custom.id)).toBe(2);
      });
      expect(order).toEqual(["x", "custom", "y"]);
      expect(custom.commits).toEqual([2]);
    } finally {
      offX();
      offY();
    }
  });

  it("drops staged writes once they commit or fail", () => {
    const app = scope(),
      x = store(0),
      y = store(0);
    const off = observe(x, y);
    withTransaction(() => {
      scoped(app, () => {
        x.value = 1;
      });
      expect(stagedOf(x)).toBeDefined();
    });
    expect(stagedOf(x)).toBeUndefined();

    const failing = makeTarget<number>({
      scope: app,
      onCommit: () => {
        throw new Error("commit failed");
      },
    });
    expect(() =>
      withTransaction(() => {
        scoped(app, () => {
          x.value = 2;
        });
        writeTransactionStore(failing.target, 1);
        scoped(app, () => {
          y.value = 3;
        });
      }),
    ).toThrow("commit failed");
    // The failed transaction applied nothing and left nothing staged.
    expect(stagedOf(x)).toBeUndefined();
    expect(stagedOf(y)).toBeUndefined();
    expect(scoped(app, () => [x.value, y.value])).toEqual([1, 0]);
    scoped(app, () => {
      y.value = 4;
    });
    expect(scoped(app, () => y.value)).toBe(4);
    off();
  });
});

describe("unobserved writes in a transaction", () => {
  it("commit at once, without a staged write", () => {
    const app = scope(),
      x = store(0);
    const id = nativeStoreStateOf(x)!.id;
    withTransaction(() => {
      scoped(app, () => {
        x.value = 1;
      });
      expect(stagedOf(x)).toBeUndefined();
      expect(isPendingStoreValue(readTransactionStore(app, id))).toBe(false);
      expect(scoped(app, () => x.value)).toBe(1);
      scoped(app, () => {
        x.value += 1;
      });
    });
    expect(scoped(app, () => x.value)).toBe(2);
  });

  it("are restored, oldest value last, when the transaction's commit fails", () => {
    const app = scope(),
      x = store(0),
      y = store<number | undefined>(undefined),
      z = store(0);
    const off = observe(z);
    scoped(app, () => {
      x.value = 1;
    });
    const failing = makeTarget<number>({
      scope: app,
      onCommit: () => {
        throw new Error("commit failed");
      },
    });
    expect(() =>
      withTransaction(() => {
        scoped(app, () => {
          x.value = 2;
          x.value = 3;
          y.value = 4;
          z.value = 5;
        });
        writeTransactionStore(failing.target, 1);
      }),
    ).toThrow("commit failed");
    expect(scoped(app, () => [x.value, y.value, z.value])).toEqual([1, undefined, 0]);
    expect(app.values.has(nativeStoreStateOf(y)!.id)).toBe(false);
    off();
  });

  it("still stage when a tracked run that wrote them observes them after it", async () => {
    const app = scope(),
      x = store(0);
    const seen: number[] = [];
    // An auto reaction reads and writes x: it observes x only once its run
    // ends, so the write must wait for the commit to notify it.
    reaction({
      scope: app,
      run: () => {
        const value = x.value;
        seen.push(value);
        if (value < 2) x.value = value + 1;
      },
    });
    await Promise.resolve();
    expect(seen).toEqual([0, 1, 2]);
  });

  it("do not notify a subscriber that starts after them in the same transaction", () => {
    const app = scope(),
      x = store(0);
    const seen: number[] = [];
    let off = (): void => {};
    withTransaction(() => {
      scoped(app, () => {
        x.value = 1;
      });
      off = x.subscribe((value) => seen.push(value));
      scoped(app, () => {
        x.value = 2;
      });
    });
    // The second write found a subscriber and was staged; the first had none.
    expect(seen).toEqual([2]);
    off();
  });
});

describe("observed writes in a transaction", () => {
  it("commit at once and publish when the transaction commits", () => {
    const app = scope(),
      x = store(0);
    const id = nativeStoreStateOf(x)!.id;
    const seen: number[] = [];
    const off = x.subscribe((value) => seen.push(value));
    withTransaction(() => {
      scoped(app, () => {
        x.value = 1;
        x.value = 2;
      });
      // The value is in the scope already; nobody has been told yet.
      expect(app.values.get(id)).toBe(2);
      expect(readTransactionStore(app, id)).toBe(2);
      expect(seen).toEqual([]);
    });
    expect(seen).toEqual([2]);
    off();
  });

  it("publish nothing when the transaction writes the value back", () => {
    const app = scope(),
      x = store(0),
      doubled = x.map((value) => value * 2);
    const seen: number[] = [];
    const offX = x.subscribe((value) => seen.push(value));
    const offDoubled = doubled.subscribe((value) => seen.push(value));
    scoped(app, () => {
      x.value = 1;
    });
    withTransaction(() => {
      scoped(app, () => {
        x.value = 5;
        x.value = 1;
      });
    });
    expect(seen).toEqual([1, 2]);
    expect(scoped(app, () => [x.value, doubled.value])).toEqual([1, 2]);
    offX();
    offDoubled();
  });

  it("keep each scope's value when one store is written in several", () => {
    const left = scope(),
      right = scope(),
      x = store(0);
    const seen: [string, number][] = [];
    const off = x.subscribe((value, at) => seen.push([at === left ? "left" : "right", value]));
    withTransaction(() => {
      scoped(left, () => {
        x.value = 1;
      });
      scoped(right, () => {
        x.value = 2;
      });
      scoped(left, () => {
        x.value = 3;
      });
      expect(scoped(left, () => x.value)).toBe(3);
      expect(scoped(right, () => x.value)).toBe(2);
    });
    expect([scoped(left, () => x.value), scoped(right, () => x.value)]).toEqual([3, 2]);
    expect(seen).toEqual([
      ["left", 3],
      ["right", 2],
    ]);
    off();
  });

  it("are restored when a commit after them fails", () => {
    const app = scope(),
      x = store(0);
    const off = observe(x);
    const failing = makeTarget<number>({
      scope: app,
      onCommit: () => {
        throw new Error("commit failed");
      },
    });
    expect(() =>
      withTransaction(() => {
        writeTransactionStore(failing.target, 1);
        scoped(app, () => {
          x.value = 2;
        });
      }),
    ).toThrow("commit failed");
    expect(scoped(app, () => x.value)).toBe(0);
    expect(app.values.has(nativeStoreStateOf(x)!.id)).toBe(false);
    off();
  });
});
