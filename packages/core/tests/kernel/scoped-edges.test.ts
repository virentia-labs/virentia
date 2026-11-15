import { afterEach, describe, expect, it } from "vitest";
import { scope } from "../../lib";
import { node, run, setActiveScope } from "../../lib/internal";
import {
  detachScopedDependent,
  disposeScopeEdges,
  getScopedObservers,
  hasScopedObservers,
  peekScopedObservers,
  reconcileScopedEdges,
  reconcileScopedSource,
  reconcileScopedOwnedEdges,
  sharedScopedEdge,
  soleScopedObserver,
  visitScopedObservers,
} from "../../lib/kernel/scoped-edges";
import type { Node } from "../../lib/kernel/types";
import type { Scope } from "../../lib";
import { ids } from "../support/kernel-node";

/** Observers of `source` in `scope`, in visit order, without requesting a handle. */
const visited = (s: Scope, source: Node): PropertyKey[] => {
  const seen: PropertyKey[] = [];
  visitScopedObservers(s, source, {
    visitScopedObserver(observer) {
      seen.push(observer.id as PropertyKey);
      return true;
    },
  });
  return seen;
};

describe("scoped edges", () => {
  // Reset the ambient scope after every test so a manual setActiveScope() or an
  // async tail's neutral reset never leaks into the next test.
  const reset = (): void => void setActiveScope(null);

  afterEach(reset);

  describe("dependency sets", () => {
    it("checks presence without materializing shared or native single-edge handles", () => {
      const app = scope(),
        other = scope(),
        source = node(),
        absent = node(),
        first = node(),
        second = node();
      const shared = sharedScopedEdge(source, first);
      reconcileScopedSource(app, first, source, shared);
      expect(hasScopedObservers(app, source)).toBe(true);
      expect(hasScopedObservers(app, absent)).toBe(false);
      expect(hasScopedObservers(other, source)).toBe(false);
      expect(peekScopedObservers(app, source)).toBe(shared);

      const native = {
        source,
        dependent: first,
        observers: undefined as Set<typeof first> | undefined,
      };
      reconcileScopedSource(other, first, source, native);
      expect(hasScopedObservers(other, source)).toBe(true);
      expect(native.observers).toBeUndefined();
      const exposed = getScopedObservers(other, source)! as Set<typeof first>;
      exposed.clear();
      expect(hasScopedObservers(other, source)).toBe(false);
      expect(hasScopedObservers(app, source)).toBe(true);
      reconcileScopedSource(app, second, source);
      expect(hasScopedObservers(app, source)).toBe(true);
      detachScopedDependent(app, first);
      expect(hasScopedObservers(app, source)).toBe(true);
      detachScopedDependent(app, second);
      expect(hasScopedObservers(app, source)).toBe(false);
    });

    it("copies caller-owned sets and separately accepts exclusive transfer", () => {
      const app = scope();
      const a = node(),
        b = node(),
        dependent = node();
      const input = new Set([a, b, dependent]);
      reconcileScopedEdges(app, dependent, input);
      input.clear();
      expect([...getScopedObservers(app, a)!]).toEqual([dependent]);
      expect([...getScopedObservers(app, b)!]).toEqual([dependent]);
      const transferred = new Set([a, dependent]);
      reconcileScopedOwnedEdges(app, dependent, transferred);
      expect(transferred.has(dependent)).toBe(false);
      expect([...getScopedObservers(app, a)!]).toEqual([dependent]);
      expect(getScopedObservers(app, b)?.size ?? 0).toBe(0);
      detachScopedDependent(app, dependent);
      expect(getScopedObservers(app, a)?.size ?? 0).toBe(0);
    });
    it("does not copy private edge state with public scope data and accepts frozen scopes", () => {
      const original = scope();
      const source = node(),
        first = node(),
        second = node();
      reconcileScopedSource(original, first, source);
      const copied = Object.freeze({
        ...original,
        values: new Map(original.values),
        handlers: new Map(original.handlers),
        deps: new Map(original.deps),
      });
      expect(getScopedObservers(copied, source)).toBeUndefined();
      reconcileScopedSource(copied, second, source);
      expect([...getScopedObservers(original, source)!]).toEqual([first]);
      expect([...getScopedObservers(copied, source)!]).toEqual([second]);
      disposeScopeEdges(copied);
      expect([...getScopedObservers(original, source)!]).toEqual([first]);
      Object.freeze(original);
      reconcileScopedSource(original, second, source);
      expect([...getScopedObservers(original, source)!]).toEqual([first, second]);
      disposeScopeEdges(original);
      expect(getScopedObservers(original, source)).toBeUndefined();
    });
    it("stay independent per scope", () => {
      const s1 = scope();
      const s2 = scope();
      const a = node({ id: "a" });
      const b = node({ id: "b" });
      const reaction = node({ id: "r" });

      // Same dependent reads `a` in s1 and `b` in s2 (data-dependent branches).
      reconcileScopedEdges(s1, reaction, [a]);
      reconcileScopedEdges(s2, reaction, [b]);

      expect(ids(getScopedObservers(s1, a))).toEqual(["r"]);
      expect(ids(getScopedObservers(s1, b))).toEqual([]);
      expect(ids(getScopedObservers(s2, b))).toEqual(["r"]);
      expect(ids(getScopedObservers(s2, a))).toEqual([]);
    });

    it("in one scope survive a reconcile in another", () => {
      const s1 = scope();
      const s2 = scope();
      const a = node({ id: "a" });
      const b = node({ id: "b" });
      const reaction = node({ id: "r" });

      reconcileScopedEdges(s1, reaction, [a]);
      reconcileScopedEdges(s2, reaction, [b]);

      // Re-running in s2 must not touch s1's edge on `a`.
      reconcileScopedEdges(s2, reaction, [a, b]);

      expect(ids(getScopedObservers(s1, a))).toEqual(["r"]);
      expect(ids(getScopedObservers(s2, a))).toEqual(["r"]);
      expect(ids(getScopedObservers(s2, b))).toEqual(["r"]);
    });
  });

  describe("reconcile", () => {
    it("shares immutable single-edge topology without sharing observer handles or mutations", () => {
      const a = node(),
        b = node(),
        first = node(),
        second = node();
      const left = scope(),
        right = scope(),
        detached = scope(),
        retargeted = scope(),
        promoted = scope();
      const shared = sharedScopedEdge(a, first);
      expect(Object.isFrozen(shared)).toBe(true);
      let initializations = 0;
      const initial = () => {
        initializations++;
        return shared;
      };
      for (const app of [left, right, detached, retargeted, promoted])
        reconcileScopedSource(app, first, a, initial);
      reconcileScopedSource(left, first, a, initial);
      expect(initializations).toBe(5);
      reconcileScopedSource(retargeted, first, b);
      expect([...getScopedObservers(retargeted, b)!]).toEqual([first]);
      reconcileScopedSource(promoted, second, a);
      expect([...getScopedObservers(promoted, a)!]).toEqual([first, second]);
      detachScopedDependent(detached, first);
      expect(getScopedObservers(detached, a)).toBeUndefined();
      const l = getScopedObservers(left, a)!,
        r = getScopedObservers(right, a)!;
      expect(l).not.toBe(r);
      reconcileScopedSource(left, first, b);
      expect(l.size).toBe(0);
      expect([...r]).toEqual([first]);
      expect(shared.source).toBe(a);
      disposeScopeEdges(right);
      expect(getScopedObservers(right, a)).toBeUndefined();
    });

    it("reuses a frozen native consumer as its single edge before promotion", () => {
      const app = scope(),
        a = node(),
        b = node(),
        first = node(),
        second = node();
      class Edge {
        #source = a;
        #observers?: Set<typeof first>;
        readonly dependent = first;
        get source() {
          return this.#source;
        }
        set source(source: typeof a) {
          this.#source = source;
        }
        get observers() {
          return this.#observers;
        }
        set observers(observers: Set<typeof first> | undefined) {
          this.#observers = observers;
        }
      }
      const edge = Object.freeze(new Edge());
      reconcileScopedSource(app, first, a, edge);
      const original = getScopedObservers(app, a)!;
      expect(edge.observers).toBe(original);
      expect([...original]).toEqual([first]);
      reconcileScopedSource(app, first, b);
      expect(original.size).toBe(0);
      expect(edge.source).toBe(b);
      const promoted = getScopedObservers(app, b)!;
      reconcileScopedSource(app, second, b);
      expect([...promoted]).toEqual([first, second]);
      detachScopedDependent(app, first);
      expect([...promoted]).toEqual([second]);
      disposeScopeEdges(app);
      expect(getScopedObservers(app, b)).toBeUndefined();
    });

    it("supports fixed sources, promotion, retargeting and self-edge removal", () => {
      const app = scope();
      const a = node(),
        b = node(),
        first = node(),
        second = node();
      reconcileScopedSource(app, first, a);
      const original = getScopedObservers(app, a)!;
      reconcileScopedSource(app, first, b);
      expect(original.size).toBe(0);
      reconcileScopedSource(app, second, b);
      expect([...getScopedObservers(app, b)!]).toEqual([first, second]);
      reconcileScopedSource(app, first, a);
      expect([...getScopedObservers(app, b)!]).toEqual([second]);
      reconcileScopedSource(app, second, second);
      expect(getScopedObservers(app, b)).toBeUndefined();
      reconcileScopedSource(app, first, first);
      expect(getScopedObservers(app, a)).toBeUndefined();
      reconcileScopedSource(app, first, a);
      detachScopedDependent(app, first);
      expect(getScopedObservers(app, a)).toBeUndefined();
    });

    it("keeps observer handles correct while a single edge grows and changes source", () => {
      const s = scope();
      const a = node(),
        b = node(),
        first = node(),
        second = node();
      reconcileScopedEdges(s, first, [a]);
      const original = getScopedObservers(s, a)!;
      reconcileScopedEdges(s, first, [b]);
      expect(original.size).toBe(0);
      const current = getScopedObservers(s, b)!;
      reconcileScopedEdges(s, second, [b]);
      expect(current).toBe(getScopedObservers(s, b));
      expect([...current]).toEqual([first, second]);
      reconcileScopedEdges(s, first, [a, b]);
      detachScopedDependent(s, second);
      expect([...current]).toEqual([first]);
      detachScopedDependent(s, first);
      expect(current.size).toBe(0);
      expect(getScopedObservers(s, a)).toBeUndefined();
      expect(getScopedObservers(s, b)).toBeUndefined();
    });

    it("repoints a dependent from a dropped source to a new one", () => {
      const s = scope();
      const a = node({ id: "a" });
      const b = node({ id: "b" });
      const reaction = node({ id: "r" });

      reconcileScopedEdges(s, reaction, [a]);
      expect(ids(getScopedObservers(s, a))).toEqual(["r"]);

      // Branch flips: now depends on `b`, not `a`.
      reconcileScopedEdges(s, reaction, [b]);
      expect(ids(getScopedObservers(s, a))).toEqual([]);
      expect(ids(getScopedObservers(s, b))).toEqual(["r"]);
    });

    it("excludes a self-edge so a node never observes itself", () => {
      const s = scope();
      const a = node({ id: "a" });
      const r = node({ id: "r" });

      reconcileScopedEdges(s, r, [r, a]);

      expect(getScopedObservers(s, r)).toBeUndefined();
      expect(ids(getScopedObservers(s, a))).toEqual(["r"]);
    });

    it("to an empty set tears the scope record down cleanly", () => {
      const s = scope();
      const a = node({ id: "a" });
      const r = node({ id: "r" });
      const r2 = node({ id: "r2" });

      reconcileScopedEdges(s, r, [a]);
      reconcileScopedEdges(s, r, []);
      expect(getScopedObservers(s, a)).toBeUndefined();

      // Scope record was torn down; a fresh dependent still works.
      reconcileScopedEdges(s, r2, [a]);
      expect(ids(getScopedObservers(s, a))).toEqual(["r2"]);
    });

    it("leaves no duplicate observer when run twice with the same sources", () => {
      const s = scope();
      const a = node({ id: "a" });
      const r = node({ id: "r" });

      reconcileScopedEdges(s, r, [a]);
      reconcileScopedEdges(s, r, [a]);

      expect(ids(getScopedObservers(s, a))).toEqual(["r"]);
    });

    it("copies its input set so later mutations do not leak in", () => {
      const s = scope();
      const a = node({ id: "a" });
      const b = node({ id: "b" });
      const r = node({ id: "r" });

      const src = new Set([a]);
      reconcileScopedEdges(s, r, src);
      src.add(b);

      expect(getScopedObservers(s, b)).toBeUndefined();
      expect(ids(getScopedObservers(s, a))).toEqual(["r"]);
    });
  });

  describe("detach", () => {
    it("removes a dependent from every source in a scope", () => {
      const s = scope();
      const a = node({ id: "a" });
      const b = node({ id: "b" });
      const reaction = node({ id: "r" });

      reconcileScopedEdges(s, reaction, [a, b]);
      detachScopedDependent(s, reaction);

      expect(getScopedObservers(s, a)).toBeUndefined();
      expect(getScopedObservers(s, b)).toBeUndefined();
    });

    it("of the last dependent deletes the forward key rather than leaving an empty set", () => {
      const s = scope();
      const a = node({ id: "a" });
      const r = node({ id: "r" });

      reconcileScopedEdges(s, r, [a]);
      detachScopedDependent(s, r);

      expect(getScopedObservers(s, a)).toBeUndefined();
    });

    it("of one dependent keeps the other's edge", () => {
      const s = scope();
      const a = node({ id: "a" });
      const r1 = node({ id: "r1" });
      const r2 = node({ id: "r2" });

      reconcileScopedEdges(s, r1, [a]);
      reconcileScopedEdges(s, r2, [a]);
      detachScopedDependent(s, r1);

      expect(ids(getScopedObservers(s, a))).toEqual(["r2"]);
    });
  });

  describe("a scope with a few edges", () => {
    it("keeps them in creation order and answers without exposing a handle", () => {
      const s = scope();
      const [a, b, c] = ["a", "b", "c"].map((id) => node({ id }));
      const [r1, r2, r3] = ["r1", "r2", "r3"].map((id) => node({ id }));
      reconcileScopedEdges(s, r1, [a, b, a]);
      reconcileScopedSource(s, r2, a);
      reconcileScopedOwnedEdges(s, r3, new Set([c, r3, a]));
      expect(visited(s, a)).toEqual(["r1", "r2", "r3"]);
      expect(visited(s, b)).toEqual(["r1"]);
      expect(visited(s, c)).toEqual(["r3"]);
      expect(soleScopedObserver(s, a)).toBeNull();
      expect(soleScopedObserver(s, b)).toBe(r1);
      expect(soleScopedObserver(s, r3)).toBeUndefined();
      expect(hasScopedObservers(s, c)).toBe(true);
      expect(hasScopedObservers(s, r1)).toBe(false);

      // A kept edge keeps its place; a new one goes last.
      reconcileScopedEdges(s, r1, [c, a]);
      expect(visited(s, a)).toEqual(["r1", "r2", "r3"]);
      expect(visited(s, b)).toEqual([]);
      expect(visited(s, c)).toEqual(["r3", "r1"]);
      reconcileScopedSource(s, r2, c);
      expect(visited(s, a)).toEqual(["r1", "r3"]);
      expect(visited(s, c)).toEqual(["r3", "r1", "r2"]);
      // A visitor may stop early.
      let calls = 0;
      expect(
        visitScopedObservers(s, c, {
          visitScopedObserver: () => ++calls < 2,
        }),
      ).toBe(false);
      expect(calls).toBe(2);

      detachScopedDependent(s, r3);
      expect(visited(s, a)).toEqual(["r1"]);
      expect(visited(s, c)).toEqual(["r1", "r2"]);
      reconcileScopedSource(s, r2, r2);
      reconcileScopedEdges(s, r1, []);
      expect(hasScopedObservers(s, a)).toBe(false);
      expect(hasScopedObservers(s, c)).toBe(false);
      expect(soleScopedObserver(s, c)).toBeUndefined();
      // Torn down, the scope starts again from a single edge.
      reconcileScopedSource(s, r1, b);
      expect(visited(s, b)).toEqual(["r1"]);
    });

    it("promotes to the indexed form past eight edges or when a handle is requested", () => {
      const s = scope(),
        t = scope();
      const source = node({ id: "source" });
      const dependents = Array.from({ length: 9 }, (_, index) => node({ id: `d${index}` }));
      dependents.slice(0, 8).forEach((dependent) => reconcileScopedSource(s, dependent, source));
      expect(visited(s, source)).toEqual(dependents.slice(0, 8).map((d) => d.id));
      reconcileScopedSource(s, dependents[8], source);
      expect(visited(s, source)).toEqual(dependents.map((d) => d.id));
      detachScopedDependent(s, dependents[0]);
      expect(visited(s, source)).toEqual(dependents.slice(1).map((d) => d.id));

      // One dependent reading many sources crosses the limit the same way.
      const sources = Array.from({ length: 10 }, (_, index) => node({ id: `s${index}` }));
      const reader = node({ id: "reader" });
      reconcileScopedEdges(t, reader, sources.slice(0, 3));
      reconcileScopedEdges(t, reader, sources);
      for (const each of sources) expect(visited(t, each)).toEqual(["reader"]);
      reconcileScopedEdges(t, reader, sources.slice(5));
      expect(visited(t, sources[0])).toEqual([]);
      expect(visited(t, sources[9])).toEqual(["reader"]);

      const u = scope(),
        first = node({ id: "first" }),
        second = node({ id: "second" });
      reconcileScopedSource(u, first, source);
      reconcileScopedSource(u, second, source);
      const handle = getScopedObservers(u, source)!;
      expect(ids(handle)).toEqual(["first", "second"]);
      detachScopedDependent(u, first);
      expect(ids(handle)).toEqual(["second"]);
      reconcileScopedSource(u, first, source);
      expect(ids(handle)).toEqual(["second", "first"]);
    });

    it.each([
      [3, 3],
      [5, 6],
    ])(
      "orders observers exactly like the indexed form (%i sources, %i dependents)",
      (sourceCount, dependentCount) => {
        // Same operations on two scopes: one keeps its natural representation
        // (mostly a pair list with few nodes), the other is indexed up front.
        // mulberry32: deterministic and well mixed in its low bits.
        let seed = 7;
        const random = (limit: number) => {
          seed = (seed + 0x6d2b79f5) | 0;
          let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
          t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
          return ((t ^ (t >>> 14)) >>> 0) % limit;
        };
        const sources = Array.from({ length: sourceCount }, (_, index) =>
          node({ id: `s${index}` }),
        );
        const dependents = Array.from({ length: dependentCount }, (_, index) =>
          node({ id: `d${index}` }),
        );
        const pinned = node({ id: "pinned" }),
          pinnedSource = node({ id: "pinnedSource" });
        for (let round = 0; round < 20; round++) {
          const natural = scope(),
            indexed = scope();
          // An untouched edge keeps the indexed scope from being torn down.
          reconcileScopedEdges(indexed, pinned, [pinnedSource, sources[0]]);
          getScopedObservers(indexed, pinnedSource);
          reconcileScopedEdges(indexed, pinned, [pinnedSource]);
          for (let step = 0; step < 40; step++) {
            const dependent = dependents[random(dependents.length)];
            const op = random(5);
            const mask = random(1 << sourceCount),
              single = sources[random(sources.length)];
            for (const s of [natural, indexed]) {
              if (op === 0) detachScopedDependent(s, dependent);
              else if (op === 1) reconcileScopedSource(s, dependent, single);
              else {
                const picked = sources.filter((_, index) => (mask >> index) & 1);
                if (op === 2) reconcileScopedEdges(s, dependent, [...picked, dependent]);
                else reconcileScopedOwnedEdges(s, dependent, new Set(picked));
              }
            }
            for (const source of [...sources, ...dependents])
              expect(visited(natural, source)).toEqual(visited(indexed, source));
          }
        }
      },
    );
  });

  it("clear for an entire scope when it is disposed", () => {
    const s = scope();
    const a = node({ id: "a" });
    const reaction = node({ id: "r" });

    reconcileScopedEdges(s, reaction, [a]);
    disposeScopeEdges(s);

    expect(getScopedObservers(s, a)).toBeUndefined();
  });

  describe("firing", () => {
    it("runs a scoped observer only in the scope that registered it", async () => {
      const s1 = scope();
      const s2 = scope();
      const ran: string[] = [];
      const r = node(() => ran.push("r"));
      const a = node(() => ran.push("a"));

      reconcileScopedEdges(s1, r, [a]);

      await run({ unit: a, scope: s1 });
      expect(ran).toEqual(["a", "r"]);

      ran.length = 0;
      await run({ unit: a, scope: s2 });
      expect(ran).toEqual(["a"]);
      reset();
    });

    it("reaches both a node's static next edges and its scoped observers", async () => {
      const s = scope();
      const ran: string[] = [];
      const staticNext = node(() => ran.push("static"));
      const r = node(() => ran.push("r"));
      const a = node({ run: () => ran.push("a"), next: [staticNext] });

      reconcileScopedEdges(s, r, [a]);

      await run({ unit: a, scope: s });
      expect(ran).toEqual(["a", "static", "r"]);
      reset();
    });
  });
});
