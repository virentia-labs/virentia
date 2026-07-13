import { describe, expect, it } from "vitest";
import { event, reaction, scope, scoped, store } from "../../lib";
import type { Reaction } from "../../lib";
import { run, withTransaction } from "../../lib/internal";
import { flush } from "../support/store-helpers";

describe("reaction corner cases", () => {
  describe("scope-less explicit reaction on a store", () => {
    it("fires in a scope created after the reaction was registered", async () => {
      const s = store(0);
      const seen: number[] = [];

      // No `scope:` config → the explicit reaction attaches a scope-independent
      // static edge to the store. It exists before any real scope does.
      reaction({ on: s, run: (v) => seen.push(v) });

      // The scope is born only now, strictly after registration.
      const late = scope();

      await run({ unit: s.node, payload: 5, scope: late });
      expect(seen).toEqual([5]); // static edge → fires in a later-born scope

      const alsoLate = scope();
      await run({ unit: s.node, payload: 6, scope: alsoLate });
      expect(seen).toEqual([5, 6]); // and in any other real scope too
    });
  });

  describe("explicit reaction on two sources changed in one transaction", () => {
    it("runs once per distinct source — distinct sources are not batch-coalesced", async () => {
      const a = store(0);
      const b = store(0);
      const sc = scope();
      const seen: number[] = [];

      // on: [a, b] — two DISTINCT sources feeding one reaction.
      reaction({ on: [a, b] as const, run: (v) => seen.push(v) });

      scoped(sc, () =>
        withTransaction(() => {
          a.value = 1;
          b.value = 2;
        }),
      );

      await flush();

      // CONTRACT: source-driven coalescing only collapses repeated writes to the
      // SAME source (see reactions.test.ts "collapses several writes ..."). Two
      // distinct sources committing in one transaction are NOT coalesced into a
      // single run — the reaction runs once per source, with each source's
      // committed value.
      expect(seen).toEqual([1, 2]);
    });
  });

  describe("two explicit reactions on the same store", () => {
    it("fire in registration order on a single change", async () => {
      const s = store(0);
      const sc = scope();
      const log: string[] = [];

      reaction({ on: s, run: () => log.push("first") });
      reaction({ on: s, run: () => log.push("second") });

      await run({ unit: s.node, payload: 1, scope: sc });
      expect(log).toEqual(["first", "second"]); // static edges fire in registration order
    });
  });

  describe("a reaction whose body creates another reaction", () => {
    it("does not leak the inner reaction's creation-pass reads into the outer's dependencies", async () => {
      const sc = scope();
      const x = store(1);
      const y = store(10);
      const outerSeen: number[] = [];
      const innerSeen: number[] = [];
      let outer!: Reaction;
      let inner!: Reaction;
      let built = false;

      scoped(sc, () => {
        outer = reaction(() => {
          outerSeen.push(x.value);
          // Build the inner reaction exactly once, from inside the outer body.
          if (!built) {
            built = true;
            inner = reaction(() => {
              innerSeen.push(y.value);
            });
          }
        });
      });

      expect(outerSeen).toEqual([1]); // outer creation pass
      expect(innerSeen).toEqual([10]); // inner creation pass ran inside it

      // The inner's read of `y` must NOT bleed into the outer's dependency set.
      expect(outer.dependencies()).toContain(x.node);
      expect(outer.dependencies()).not.toContain(y.node);
      // The inner tracks `y` as its own dependency.
      expect(inner.dependencies()).toContain(y.node);

      // Changing `y` re-runs only the inner, never the outer.
      await run({ unit: y.node, payload: 20, scope: sc });
      expect(innerSeen).toEqual([10, 20]);
      expect(outerSeen).toEqual([1]); // outer untouched by y

      // Changing `x` re-runs the outer (guard keeps it from rebuilding inner).
      await run({ unit: x.node, payload: 2, scope: sc });
      expect(outerSeen).toEqual([1, 2]);
      expect(innerSeen).toEqual([10, 20]); // inner not re-created
    });
  });

  describe("explicit reaction fed by a store AND an event", () => {
    it("fires for both source kinds, in the order they occur", async () => {
      const s = store(0);
      const ev = event<number>();
      const sc = scope();
      const seen: number[] = [];

      reaction({ on: [s, ev] as const, run: (v) => seen.push(v) });

      await run({ unit: s.node, payload: 1, scope: sc }); // store feeds it
      await scoped(sc, () => ev(2)); // event feeds it
      await run({ unit: s.node, payload: 3, scope: sc }); // store again

      expect(seen).toEqual([1, 2, 3]); // both source kinds fire, in occurrence order
    });
  });
});
