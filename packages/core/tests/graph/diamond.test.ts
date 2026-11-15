import { describe, expect, it } from "vitest";
import { computed, event, reaction, scope, scoped, store } from "../../lib";
import { withTransaction } from "../../lib/internal";

// A diamond: a -> b, a -> c, (b, c) -> d. Both b and c derive from a, and d
// reads both. An observer (a reaction, a subscriber) must not see an
// intermediate value of an update before its transaction commits: it runs once
// per committed transaction, with the final value of every unit. The counts of
// computed evaluations CHARACTERIZE the behavior observed today: d is evaluated
// exactly once per change to a (not once per path) and never sees a mix of a
// stale and a fresh dependency. A regression that reintroduced a glitch (double
// recompute, torn read, duplicate notification) would fail here.
describe("dependency graph", () => {
  describe("a diamond dependency", () => {
    it("evaluates the shared dependant exactly once when the shared source changes", () => {
      const sc = scope();
      const a = store(1);
      let dCalls = 0;
      const b = computed(() => a.value + 1);
      const c = computed(() => a.value * 2);
      const d = computed(() => {
        dCalls += 1;
        return b.value + c.value;
      });
      reaction({ scope: sc, run: () => void d.value });

      const afterCreate = dCalls;
      scoped(sc, () => {
        a.value = 10;
      });

      // One recompute for the single change to a — not one per diamond path.
      expect(dCalls - afterCreate).toBe(1);
    });

    it("never exposes a mix of a stale and a fresh dependency", () => {
      const sc = scope();
      const a = store(1);
      const seenPairs: Array<[number, number]> = [];
      const b = computed(() => a.value + 1);
      const c = computed(() => a.value * 2);
      const d = computed(() => {
        const bv = b.value;
        const cv = c.value;
        seenPairs.push([bv, cv]);
        return bv + cv;
      });
      reaction({ scope: sc, run: () => void d.value });

      scoped(sc, () => {
        a.value = 10;
      });
      scoped(sc, () => {
        a.value = 7;
      });

      // Every evaluation of d saw b and c derived from the SAME a (b = a+1,
      // c = a*2), so (b-1) must equal (c/2). A glitch that paired a fresh b with a
      // stale c (or vice-versa) would break this equality.
      for (const [bv, cv] of seenPairs) {
        expect(bv - 1).toBe(cv / 2);
      }
    });

    it("notifies the observer once per change to the shared source", () => {
      const sc = scope();
      const a = store(1);
      const b = computed(() => a.value + 1);
      const c = computed(() => a.value * 2);
      const d = computed(() => b.value + c.value);
      const seen: number[] = [];
      reaction({ scope: sc, run: () => seen.push(d.value) });

      scoped(sc, () => {
        a.value = 10; // b:11, c:20, d:31
      });
      scoped(sc, () => {
        a.value = 7; // b:8, c:14, d:22
      });

      // Initial run (4) + one notification per change. No duplicate from the two
      // diamond paths.
      expect(seen).toEqual([4, 31, 22]);
    });
  });

  describe("paths of different lengths", () => {
    // head -> c1 -> c2 -> c3 -> c4, and one computed reading every level.
    function chain(read: (levels: { value: number }[]) => number) {
      const head = store(0);
      const levels: { value: number }[] = [head];
      for (let index = 0; index < 4; index++) {
        const previous = levels[index];
        levels.push(computed(() => previous.value + 1));
      }
      return { head, sum: computed(() => read(levels)) };
    }

    for (const [order, read] of [
      [
        "shallow first",
        (levels: { value: number }[]) => levels.reduce((total, unit) => total + unit.value, 0),
      ],
      [
        "deep first",
        (levels: { value: number }[]) => levels.reduceRight((total, unit) => total + unit.value, 0),
      ],
    ] as const) {
      it(`shows a reader of every level only the final value (${order})`, () => {
        const sc = scope();
        const { head, sum } = chain(read);
        const seen: number[] = [];
        const ran: number[] = [];
        reaction({ scope: sc, on: sum, run: (value: number) => void seen.push(value) });
        reaction({ scope: sc, run: () => void ran.push(sum.value) });
        scoped(sc, () => sum.value);
        ran.length = 0;

        scoped(sc, () => {
          head.value = 1;
        });
        expect(seen).toEqual([15]);
        expect(ran).toEqual([15]);
      });
    }

    it("keeps a subscriber to one notification per change", () => {
      const sc = scope();
      const { head, sum } = chain((levels) =>
        levels.reduce((total, unit) => total + unit.value, 0),
      );
      const seen: number[] = [];
      scoped(sc, () => sum.value);
      const unsubscribe = sum.subscribe((value) => void seen.push(value));
      scoped(sc, () => {
        head.value = 2;
      });
      expect(seen).toEqual([20]);
      unsubscribe();
    });

    it("does not recompute behind a value that did not change", () => {
      const sc = scope();
      const head = store(0);
      const first = computed(() => head.value);
      const constant = computed(() => (first.value, 0));
      let costly = 0;
      const last = computed(() => {
        costly += 1;
        return constant.value + 1;
      });
      let ran = 0;
      reaction({ scope: sc, on: last, run: () => void (ran += 1) });
      scoped(sc, () => last.value);
      costly = 0;

      scoped(sc, () => {
        head.value = 5;
      });
      expect(costly).toBe(0);
      expect(ran).toBe(0);
    });

    it("recomputes an unread reader left checked by earlier updates", () => {
      const sc = scope();
      const head = store(0);
      const other = store(0);
      const first = computed(() => head.value + 1);
      let runs = 0;
      const lazy = computed(() => {
        runs += 1;
        return first.value * 2;
      });
      const lazier = computed(() => lazy.value + 1);
      reaction({ scope: sc, run: () => void (first.value + other.value) });
      expect(scoped(sc, () => lazier.value)).toBe(3);

      // `first` changes while nothing reads `lazy`, then an unrelated update.
      scoped(sc, () => {
        head.value = 1;
      });
      scoped(sc, () => {
        other.value = 1;
      });
      expect(scoped(sc, () => lazier.value)).toBe(5);
      expect(runs).toBe(2);

      // Its source is written the same value: nothing to recompute.
      scoped(sc, () => {
        head.value = 1;
      });
      expect(scoped(sc, () => lazier.value)).toBe(5);
      expect(runs).toBe(2);
    });

    it("recomputes a reader once its source changes in a later update", () => {
      const sc = scope();
      const head = store(0);
      const first = computed(() => (head.value >= 2 ? 1 : 0));
      let runs = 0;
      const lazy = computed(() => {
        runs += 1;
        return first.value + 10;
      });
      reaction({ scope: sc, run: () => void first.value });
      expect(scoped(sc, () => lazy.value)).toBe(10);

      // `first` keeps its value: `lazy` stays checked but holds.
      scoped(sc, () => {
        head.value = 1;
      });
      // Now `first` changes, with `lazy` still checked from before.
      scoped(sc, () => {
        head.value = 2;
      });
      expect(scoped(sc, () => lazy.value)).toBe(11);
      expect(runs).toBe(2);
    });
  });

  describe("what an observer sees of an update", () => {
    // head -> c1 -> c2 -> c3 -> c4; sum reads every level plus `extra`, label
    // reads sum. Paths of different lengths meet at sum, and label sits below it.
    function observed() {
      const sc = scope();
      const head = store(0);
      const extra = store(0);
      const levels: { value: number }[] = [head];
      for (let index = 0; index < 4; index++) {
        const previous = levels[index];
        levels.push(computed(() => previous.value + 1));
      }
      const sums: number[] = [];
      const labels: number[] = [];
      const sum = computed(() => {
        const value = levels.reduce((total, unit) => total + unit.value, 0) + extra.value;
        sums.push(value);
        return value;
      });
      const label = computed(() => {
        const value = sum.value * 10;
        labels.push(value);
        return value;
      });
      const ran: number[] = [];
      const seen: number[] = [];
      const notified: number[] = [];
      reaction({ scope: sc, run: () => void ran.push(label.value) });
      reaction({ scope: sc, on: label, run: (value: number) => void seen.push(value) });
      scoped(sc, () => sum.value);
      sum.subscribe((value) => void notified.push(value));
      ran.length = 0;
      sums.length = 0;
      labels.length = 0;
      return { sc, head, extra, sums, labels, ran, seen, notified };
    }

    it("runs every observer once per write, with the final value", () => {
      const graph = observed();
      scoped(graph.sc, () => {
        graph.head.value = 1;
      });
      // Levels 1..5 sum to 15.
      expect(graph.ran).toEqual([150]);
      expect(graph.seen).toEqual([150]);
      expect(graph.notified).toEqual([15]);
    });

    it("never evaluates a computed on a mix of old and new levels", () => {
      const graph = observed();
      scoped(graph.sc, () => {
        graph.head.value = 1;
      });
      expect(graph.sums.length).toBeGreaterThan(0);
      expect(graph.sums.filter((value) => value !== 15)).toEqual([]);
      expect(graph.labels.filter((value) => value !== 150)).toEqual([]);
    });

    it("evaluates every computed once per update", () => {
      const graph = observed();
      scoped(graph.sc, () => {
        graph.head.value = 1;
      });
      expect(graph.sums).toEqual([15]);
      expect(graph.labels).toEqual([150]);

      scoped(graph.sc, () =>
        withTransaction(() => {
          graph.head.value = 2;
          graph.extra.value = 100;
        }),
      );
      expect(graph.sums).toEqual([15, 120]);
      expect(graph.labels).toEqual([150, 1200]);
    });

    it("does not evaluate a computed its last reader stopped reading in the update", () => {
      const sc = scope();
      const open = store(true);
      const query = store("a");
      const searched: string[] = [];
      const results = computed(() => {
        searched.push(query.value);
        return query.value.toUpperCase();
      });
      const rendered: string[] = [];
      reaction({
        scope: sc,
        run: () => void rendered.push(open.value ? `render ${results.value}` : "render closed"),
      });
      const close = event<string>();
      reaction({
        on: close,
        run: (next) => {
          query.value = next;
          open.value = false;
        },
      });
      searched.length = 0;
      rendered.length = 0;

      scoped(sc, () => close("b"));

      expect(rendered).toEqual(["render closed"]);
      expect(searched).toEqual([]);
      // Read later, it computes from the current sources.
      expect(scoped(sc, () => results.value)).toBe("B");
    });

    it("holds every observer until the transaction commits", () => {
      const graph = observed();
      scoped(graph.sc, () =>
        withTransaction(() => {
          graph.head.value = 1;
          graph.head.value = 2;
          graph.extra.value = 100;
          expect(graph.ran).toEqual([]);
          expect(graph.seen).toEqual([]);
          expect(graph.notified).toEqual([]);
        }),
      );
      // Levels 2..6 sum to 20.
      expect(graph.ran).toEqual([1200]);
      expect(graph.seen).toEqual([1200]);
      expect(graph.notified).toEqual([120]);
    });

    it("waits for the outermost of nested transactions", () => {
      const graph = observed();
      scoped(graph.sc, () =>
        withTransaction(() => {
          withTransaction(() => {
            graph.head.value = 1;
          });
          expect(graph.ran).toEqual([]);
          graph.extra.value = 100;
        }),
      );
      expect(graph.ran).toEqual([1150]);
      expect(graph.notified).toEqual([115]);
    });

    it("runs no observer for a transaction that restores every value", () => {
      const graph = observed();
      scoped(graph.sc, () =>
        withTransaction(() => {
          graph.head.value = 1;
          graph.head.value = 0;
        }),
      );
      expect(graph.ran).toEqual([]);
      expect(graph.seen).toEqual([]);
      expect(graph.notified).toEqual([]);
    });

    it("delivers the writes of one event's handlers as one update", () => {
      const graph = observed();
      const set = event<number>();
      let ranBeforeCommit = -1;
      reaction({
        on: set,
        run: (value) => {
          graph.head.value = value;
        },
      });
      reaction({
        on: set,
        run: (value) => {
          graph.extra.value = value * 100;
          // An error here would be contained, so the count is checked below.
          ranBeforeCommit = graph.ran.length;
        },
      });
      scoped(graph.sc, () => set(1));
      expect(ranBeforeCommit).toBe(0);
      expect(graph.ran).toEqual([1150]);
      expect(graph.notified).toEqual([115]);
    });

    it("runs once per transaction when writes commit separately", () => {
      const graph = observed();
      // A write outside any transaction commits at once, as its own update.
      scoped(graph.sc, () => {
        graph.head.value = 1;
        graph.extra.value = 100;
      });
      expect(graph.ran).toEqual([150, 1150]);
      expect(graph.notified).toEqual([15, 115]);
    });
  });
});
