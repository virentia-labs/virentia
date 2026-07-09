import { describe, expect, it } from "vitest";
import {
  computed,
  event,
  getOwner,
  onCleanup,
  owner,
  reaction,
  scope,
  scoped,
  store,
  withOwner,
} from "../../lib";
import type { Reaction, Scope } from "../../lib";
import { node, run, withTransaction } from "../../lib/internal";
import { reconcileScopedEdges } from "../../lib/kernel/scoped-edges";
import { unwrapMicroScope } from "../../lib/scope/micro";
import { getActiveScope } from "../../lib/scope/internal";
import { flush, makeGates, nextOf, observersOf } from "../support/graph-helpers";

describe("reaction", () => {
  describe("in auto mode", () => {
    it("runs immediately, tracking the stores its body reads", async () => {
      const appScope = scope();
      const counter = store(1);
      const values: number[] = [];

      reaction(() => {
        values.push(counter.value);
      });

      await run({ unit: counter.node, payload: 2, scope: appScope });

      expect(values).toEqual([1, 2]);
    });

    it("treats a config without an on field as non-explicit", async () => {
      const a = scope();
      const s = store(0);
      const seen: number[] = [];

      const r = reaction({
        run() {
          seen.push(s.value);
        },
      });

      expect(r.explicit).toBe(false);
      expect(seen).toEqual([0]); // creation pass ran once

      await run({ unit: s.node, payload: 3, scope: a });
      expect(seen).toEqual([0, 3]); // read auto-tracked as a global dependency
    });

    it("takes its handler from a bare function", async () => {
      const a = scope();
      const s = store(1);
      const seen: number[] = [];

      const r = reaction(() => {
        seen.push(s.value);
      });

      expect(r.explicit).toBe(false);
      expect(seen).toEqual([1]);
      await run({ unit: s.node, payload: 2, scope: a });
      expect(seen).toEqual([1, 2]);
    });

    it("reads initial values at creation with no active scope", () => {
      const s = store(5);
      const seen: number[] = [];

      reaction(() => seen.push(s.value));

      expect(seen).toEqual([5]); // throwaway tracking scope reads the initial value
    });

    it("runs its body exactly once at creation", () => {
      let runs = 0;
      reaction(() => {
        runs += 1;
      });
      expect(runs).toBe(1);
    });

    it("tracks dependencies without requiring scoped derived writes", async () => {
      const appScope = scope();
      const counter = store(1);
      const doubled = store(0);

      reaction(() => {
        doubled.value = counter.value * 2;
      });

      await run({ unit: counter.node, payload: 3, scope: appScope });

      scoped(appScope, () => {
        expect(doubled.value).toBe(6);
      });
    });
  });

  describe("in explicit mode", () => {
    it("does not run its body at creation, only on a fire", async () => {
      const a = scope();
      const ev = event<number>();
      const seen: number[] = [];

      scoped(a, () => reaction({ on: ev, run: (n) => seen.push(n) }));

      expect(seen).toEqual([]); // no creation-pass run

      await scoped(a, () => ev(5));
      expect(seen).toEqual([5]);
    });

    it("attaches a static edge to each on source", () => {
      const a = scope();
      const ev = event<number>();
      let r!: Reaction;

      scoped(a, () => {
        r = reaction({ on: ev, run: () => {} });
      });

      expect(nextOf(ev.node)).toContain(r.node);
      expect(r.dependencies()).toEqual([ev.node]);
    });

    it("runs its body on every fire with the firing unit's committed value", async () => {
      const a = scope();
      const counter = store(0);
      const seen: number[] = [];

      scoped(a, () => reaction({ on: counter, run: (v) => seen.push(v) }));

      await run({ unit: counter.node, payload: 7, scope: a });
      await run({ unit: counter.node, payload: 8, scope: a });
      await run({ unit: counter.node, payload: 9, scope: a });
      expect(seen).toEqual([7, 8, 9]);
    });
  });

  describe("scope matching", () => {
    it("ignores a null-scope fire when bound to a scope", async () => {
      const a = scope();
      const ev = event<number>();
      const seen: number[] = [];

      scoped(a, () => reaction({ scope: a, on: ev, run: (n) => seen.push(n) }));

      await run({ unit: ev.node, payload: 1 }); // null active scope
      expect(seen).toEqual([]); // skipped

      await run({ unit: ev.node, payload: 2, scope: a });
      expect(seen).toEqual([2]); // fires in its own scope
    });

    it("skips a fire from a non-allowed scope", async () => {
      const a = scope();
      const b = scope();
      const ev = event<number>();
      const seen: number[] = [];

      scoped(a, () => reaction({ scope: a, on: ev, run: (n) => seen.push(n) }));

      await run({ unit: ev.node, payload: 1, scope: b });
      expect(seen).toEqual([]);
      await run({ unit: ev.node, payload: 2, scope: a });
      expect(seen).toEqual([2]);
    });

    it("passes a null api.scope to a global reaction under a null scope", async () => {
      const ev = event<number>();
      const scopes: Array<Scope | null> = [];

      reaction({ on: ev, run: (_n, api) => scopes.push(api.scope) });

      await run({ unit: ev.node, payload: 1 }); // no scope
      expect(scopes).toEqual([null]); // no inFlight bookkeeping, no crash
    });

    it("passes the firing scope as api.scope to a scoped reaction", async () => {
      const a = scope();
      const ev = event<number>();
      const scopes: Array<Scope | null> = [];

      scoped(a, () => reaction({ scope: a, on: ev, run: (_n, api) => scopes.push(api.scope) }));

      await run({ unit: ev.node, payload: 1, scope: a });
      expect(scopes).toEqual([a]);
    });

    it("limits an explicit reaction to its configured scope", async () => {
      const firstScope = scope();
      const secondScope = scope();
      const counter = store(0);
      const values: number[] = [];

      reaction({
        on: counter,
        scope: secondScope,
        run: (value: number) => {
          values.push(value);
        },
      });

      await run({ unit: counter.node, payload: 1, scope: firstScope });
      await run({ unit: counter.node, payload: 2, scope: secondScope });

      expect(values).toEqual([2]);
    });

    it("runs an auto reaction in its configured scope", async () => {
      const firstScope = scope();
      const secondScope = scope();
      const counter = store(0);
      const values: number[] = [];

      scoped(secondScope, () => {
        counter.value = 10;
      });

      reaction({
        scope: secondScope,
        run: () => {
          values.push(counter.value);
        },
      });

      await run({ unit: counter.node, payload: 1, scope: firstScope });
      await run({ unit: counter.node, payload: 11, scope: secondScope });

      expect(values).toEqual([10, 11]);
    });

    it("reacts only in the scope it is bound to", async () => {
      const a = scope();
      const b = scope();
      const counter = store(0);
      const seen: number[] = [];

      // Per-scope binding is opt-in through `scope:`, never inferred from the
      // ambient scope at creation.
      reaction({
        scope: a,
        run() {
          seen.push(counter.value);
        },
      });

      expect(seen).toEqual([0]); // initial run in `a`

      // An update in another scope must not reach this reaction.
      await run({ unit: counter.node, payload: 1, scope: b });
      expect(seen).toEqual([0]);

      // An update in its own scope does.
      await run({ unit: counter.node, payload: 2, scope: a });
      expect(seen).toEqual([0, 2]);
    });
  });

  describe("global dependency reconcile", () => {
    it("moves its edge from the old source to the new on a branch switch", async () => {
      const a = scope();
      const useX = store(true);
      const x = store(1);
      const y = store(100);
      const seen: number[] = [];
      let r!: Reaction;

      scoped(a, () => {
        r = reaction(() => seen.push(useX.value ? x.value : y.value));
      });

      expect(seen).toEqual([1]);
      expect(nextOf(x.node)).toContain(r.node);
      expect(nextOf(y.node)).not.toContain(r.node);

      await run({ unit: useX.node, payload: false, scope: a }); // switch branch
      expect(seen).toEqual([1, 100]);
      expect(nextOf(x.node)).not.toContain(r.node); // old detached
      expect(nextOf(y.node)).toContain(r.node); // new attached

      await run({ unit: x.node, payload: 2, scope: a }); // stale source: no re-run
      expect(seen).toEqual([1, 100]);
      await run({ unit: y.node, payload: 200, scope: a }); // tracked source: re-run
      expect(seen).toEqual([1, 100, 200]);
    });

    it("resizes the dependency set without stale or duplicate edges", async () => {
      const a = scope();
      const count = store(0);
      const s0 = store(10);
      const s1 = store(20);
      const seen: number[] = [];
      let r!: Reaction;

      scoped(a, () => {
        r = reaction(() => {
          let sum = 0;
          const k = count.value;
          if (k >= 1) sum += s0.value;
          if (k >= 2) sum += s1.value;
          seen.push(sum);
        });
      });

      expect(r.dependencies()).toEqual([count.node]);

      await run({ unit: count.node, payload: 1, scope: a });
      expect(new Set(r.dependencies())).toEqual(new Set([count.node, s0.node]));

      await run({ unit: count.node, payload: 2, scope: a });
      expect(new Set(r.dependencies())).toEqual(new Set([count.node, s0.node, s1.node]));

      await run({ unit: count.node, payload: 0, scope: a }); // full shrink back to {count}
      expect(r.dependencies()).toEqual([count.node]);

      // No double-attach across all those reconciles.
      expect(nextOf(count.node).filter((n) => n === r.node)).toHaveLength(1);
      expect(seen).toEqual([0, 10, 30, 0]);
    });

    it("commits global edges that fire in any scope when created with no ambient scope", async () => {
      const s = store(0);
      const seen: number[] = [];
      const a = scope();
      const b = scope();

      reaction(() => seen.push(s.value));

      await run({ unit: s.node, payload: 1, scope: a });
      await run({ unit: s.node, payload: 2, scope: b });
      expect(seen).toEqual([0, 1, 2]); // global edges → any real scope re-runs it
    });

    it("returns a fresh dependencies() snapshot, not the live set", async () => {
      const a = scope();
      const useX = store(true);
      const x = store(0);
      const y = store(0);
      let r!: Reaction;

      scoped(a, () => {
        r = reaction(() => void (useX.value ? x.value : y.value));
      });

      const snapshot = r.dependencies();
      expect(snapshot).toEqual([useX.node, x.node]);

      await run({ unit: useX.node, payload: false, scope: a }); // reconcile → {useX, y}

      expect(snapshot).toEqual([useX.node, x.node]); // captured copy untouched
      expect(r.dependencies()).toContain(y.node);
      expect(r.dependencies()).not.toContain(x.node);
    });

    it("updates its dependencies when the read branch changes", async () => {
      const appScope = scope();
      const useLeft = store(true);
      const left = store(1);
      const right = store(10);
      const values: number[] = [];

      reaction(() => {
        values.push(useLeft.value ? left.value : right.value);
      });

      await run({ unit: right.node, payload: 11, scope: appScope });
      await run({ unit: left.node, payload: 2, scope: appScope });
      await run({ unit: useLeft.node, payload: false, scope: appScope });
      await run({ unit: left.node, payload: 3, scope: appScope });
      await run({ unit: right.node, payload: 12, scope: appScope });

      expect(values).toEqual([1, 2, 11, 12]);
    });
  });

  describe("per-scope edges", () => {
    it("stay out of a per-scope reaction's dependencies() snapshot", () => {
      const a = scope();
      const s = store(0);
      let r!: Reaction;

      scoped(a, () => {
        r = reaction({ scope: a, run: () => void s.value });
      });

      expect(r.dependencies()).toEqual([]); // scoped edges are not mirrored into currentDependencies
      expect(observersOf(a, s.node)).toContain(r.node); // but the scoped edge exists
    });

    it("stay isolated per scope for a scope-array reaction", async () => {
      const a = scope();
      const b = scope();
      const useLeft = store(true);
      const left = store(1);
      const right = store(10);

      const r = reaction({
        scope: [a, b],
        run: () => void (useLeft.value ? left.value : right.value),
      });

      // Creation pass runs in EVERY configured scope → both `a` and `b` track
      // {useLeft, left} at creation (useLeft is true in each).
      expect(observersOf(a, left.node)).toContain(r.node);
      expect(observersOf(a, right.node)).not.toContain(r.node);
      expect(observersOf(b, left.node)).toContain(r.node);
      expect(observersOf(b, right.node)).not.toContain(r.node);

      // Flip the branch in `b`, then re-run the reaction in `b`.
      await run({ unit: useLeft.node, payload: false, scope: b });
      await run({ unit: r.node, scope: b });

      // `b` now tracks {useLeft, right}; `a` is untouched by b's reconcile.
      expect(observersOf(b, right.node)).toContain(r.node);
      expect(observersOf(b, left.node)).not.toContain(r.node);
      expect(observersOf(a, left.node)).toContain(r.node); // isolation preserved
      expect(observersOf(a, right.node)).not.toContain(r.node);
    });

    it("drop a self-edge in reconcileScopedEdges", () => {
      const sc = scope();
      const dependent = node({ id: "dep" });
      const source = node({ id: "src" });

      reconcileScopedEdges(sc, dependent, [source, dependent]); // includes itself

      expect(observersOf(sc, source)).toContain(dependent);
      expect(observersOf(sc, dependent)).not.toContain(dependent); // no self-observation
    });

    it("stay isolated across scopes for two per-scope reactions", async () => {
      const a = scope();
      const b = scope();
      const useLeft = store(true);
      const left = store(1);
      const right = store(10);
      const seenA: number[] = [];
      const seenB: number[] = [];

      reaction({
        scope: a,
        run() {
          seenA.push(useLeft.value ? left.value : right.value);
        },
      });
      reaction({
        scope: b,
        run() {
          seenB.push(useLeft.value ? left.value : right.value);
        },
      });

      // Scope `b` takes the `right` branch; scope `a` stays on `left`.
      await run({ unit: useLeft.node, payload: false, scope: b });
      await run({ unit: right.node, payload: 11, scope: b });
      // Scope `a` still tracks `left`, untouched by b's reconcile.
      await run({ unit: left.node, payload: 2, scope: a });
      // A `right` change only matters to b now.
      await run({ unit: right.node, payload: 12, scope: b });

      expect(seenA).toEqual([1, 2]); // 1 (init, left), 2 (left→2); never saw b's right updates
      expect(seenB).toEqual([1, 10, 11, 12]); // 1 (init, left), 10 (useLeft→false), 11, 12
    });
  });

  describe("on sources", () => {
    it("fire the reaction for each of several listed units", async () => {
      const a = scope();
      const evA = event<number>();
      const evB = event<string>();
      const seen: Array<number | string> = [];

      scoped(a, () => reaction({ on: [evA, evB] as const, run: (v) => seen.push(v) }));

      await scoped(a, () => evA(1));
      await scoped(a, () => evB("x"));
      expect(seen).toEqual([1, "x"]);
    });

    it("behave like a single unit when given a one-element array", async () => {
      const a = scope();
      const ev = event<number>();
      const seen: number[] = [];

      scoped(a, () => reaction({ on: [ev] as const, run: (v) => seen.push(v) }));

      await scoped(a, () => ev(9));
      expect(seen).toEqual([9]);
    });

    it("attach exactly one edge for a duplicated unit, firing once", async () => {
      const a = scope();
      const ev = event<number>();
      const seen: number[] = [];
      let r!: Reaction;

      scoped(a, () => {
        r = reaction({ on: [ev, ev] as const, run: (v) => seen.push(v) });
      });

      expect(nextOf(ev.node).filter((n) => n === r.node)).toHaveLength(1);

      await scoped(a, () => ev(3));
      expect(seen).toEqual([3]); // fired once, not twice
    });
  });

  describe("scope arrays", () => {
    it("fire an explicit reaction in each listed scope, ignoring others", async () => {
      const a = scope();
      const b = scope();
      const c = scope();
      const counter = store(0);
      const seen: Array<[string, number]> = [];

      reaction({
        scope: [a, b],
        on: counter,
        run: (v, api) =>
          seen.push([api.scope === a ? "a" : api.scope === b ? "b" : "other", v]),
      });

      await run({ unit: counter.node, payload: 1, scope: a });
      await run({ unit: counter.node, payload: 2, scope: b });
      await run({ unit: counter.node, payload: 3, scope: c }); // unlisted → ignored
      expect(seen).toEqual([
        ["a", 1],
        ["b", 2],
      ]);
    });

    it("run an auto reaction's creation pass in every configured scope", () => {
      const a = scope();
      const b = scope();
      const s = store(0);
      const passScopes: Array<Scope | null> = [];

      reaction({
        scope: [a, b],
        run: () => {
          passScopes.push(unwrapMicroScope(getActiveScope()));
          void s.value;
        },
      });

      // Runs once per configured scope, so the reaction forms edges in — and can
      // fire in — each (regression: it used to run only in configuredScopes[0], so a
      // `scope: [a, b]` auto reaction was silently inert in `b`).
      expect(passScopes).toEqual([a, b]);
    });
  });

  describe("run coalescing", () => {
    it("ignores key:true, which never becomes a batch key", async () => {
      const a = scope();
      const ev = event<number>();
      const seen: number[] = [];

      scoped(a, () => reaction({ on: ev, key: true, run: (n) => seen.push(n) }));

      await scoped(a, () => ev(1));
      await scoped(a, () => ev(2));
      expect(seen).toEqual([1, 2]); // ran per payload; `key` never became a batchKey
    });

    it("collapses several writes in one transaction to a single final-value run", async () => {
      const a = scope();
      const s = store(0);
      const seen: number[] = [];

      scoped(a, () => reaction({ on: s, run: (v) => seen.push(v) }));

      scoped(a, () =>
        withTransaction(() => {
          s.value = 1;
          s.value = 2;
          s.value = 3;
        }),
      );

      await flush();
      expect(seen).toEqual([3]); // source-driven coalescing → one run with the final value
    });
  });

  describe("computed sources", () => {
    it("track a read computed, not the computed's internal source", async () => {
      const a = scope();
      const base = store(1);
      const doubled = computed(() => base.value * 2);
      const other = store(100);
      const seen: number[] = [];
      let r!: Reaction;

      scoped(a, () => {
        r = reaction(() => seen.push(doubled.value));
      });

      expect(seen).toEqual([2]);
      // The computed is a dep; `base` (its internal source) is not a direct dep of the reaction.
      expect(r.dependencies()).toContain(doubled.node);
      expect(r.dependencies()).not.toContain(base.node);

      await run({ unit: base.node, payload: 5, scope: a }); // re-runs via the computed
      expect(seen).toEqual([2, 10]);
      await run({ unit: other.node, payload: 200, scope: a }); // untracked → no re-run
      expect(seen).toEqual([2, 10]);
    });
  });

  describe("stop", () => {
    it("makes subsequent explicit fires a no-op", async () => {
      const a = scope();
      const s = store(0);
      const seen: number[] = [];
      let r!: Reaction;

      scoped(a, () => {
        r = reaction({ on: s, run: (v) => seen.push(v) });
      });

      await run({ unit: s.node, payload: 1, scope: a });
      expect(seen).toEqual([1]);

      r.stop();
      await run({ unit: s.node, payload: 2, scope: a });
      expect(seen).toEqual([1]); // body not invoked after stop()
    });

    it("makes subsequent auto scoped fires a no-op", async () => {
      const a = scope();
      const s = store(0);
      const seen: number[] = [];
      let r!: Reaction;

      scoped(a, () => {
        r = reaction({ scope: a, run: () => seen.push(s.value) });
      });

      expect(seen).toEqual([0]);
      r.stop();
      await run({ unit: s.node, payload: 5, scope: a });
      expect(seen).toEqual([0]);
    });

    it("detaches every global-edge dependency, emptying dependencies()", () => {
      const a = scope();
      const x = store(0);
      const y = store(0);
      let r!: Reaction;

      scoped(a, () => {
        r = reaction(() => void (x.value + y.value));
      });

      expect(nextOf(x.node)).toContain(r.node);
      expect(nextOf(y.node)).toContain(r.node);

      r.stop();

      expect(nextOf(x.node)).not.toContain(r.node);
      expect(nextOf(y.node)).not.toContain(r.node);
      expect(r.dependencies()).toEqual([]);
    });

    it("detaches scoped dependents in every bound scope", async () => {
      const a = scope();
      const b = scope();
      const s = store(0);

      const r = reaction({ scope: [a, b], run: () => void s.value });

      // Creation ran in `a`; drive the node in `b` to bind a `b` edge too.
      await run({ unit: r.node, scope: b });

      expect(observersOf(a, s.node)).toContain(r.node);
      expect(observersOf(b, s.node)).toContain(r.node);

      r.stop();

      expect(observersOf(a, s.node)).not.toContain(r.node);
      expect(observersOf(b, s.node)).not.toContain(r.node);
    });

    it("aborts a mid-flight async run so its completion branch is skipped", async () => {
      const a = scope();
      const trigger = event<number>();
      const gates = makeGates();
      let captured!: AbortSignal;
      let completed = false;
      let r!: Reaction;

      scoped(a, () => {
        r = reaction({
          on: trigger,
          run: async (_n, { signal }) => {
            captured = signal;
            await gates.wait();
            if (!signal.aborted) completed = true;
          },
        });
      });

      const p = run({ unit: trigger.node, payload: 1, scope: a }); // parks after registering the controller
      r.stop(); // aborts every activeRuns controller

      expect(captured.aborted).toBe(true);

      gates.release(0);
      await p;
      expect(completed).toBe(false); // completion branch skipped (signal.aborted)
    });

    it("is idempotent on an already-detached source", async () => {
      const a = scope();
      const s = store(0);
      let r!: Reaction;

      scoped(a, () => {
        r = reaction(() => void s.value);
      });

      r.stop();
      expect(() => r.stop()).not.toThrow();
      expect(r.dependencies()).toEqual([]);
    });

    it("halts an explicit reaction, emptying its dependencies", async () => {
      const appScope = scope();
      const counter = store(0);
      const values: number[] = [];
      const subscription = reaction({
        on: counter,
        run: (value: number) => {
          values.push(value);
        },
      });

      await run({ unit: counter.node, payload: 1, scope: appScope });
      subscription.stop();
      await run({ unit: counter.node, payload: 2, scope: appScope });

      expect(values).toEqual([1]);
      expect(subscription.dependencies()).toEqual([]);
    });
  });
});

describe("owner", () => {
  it("tears down its cleanups and owned graph work on dispose", async () => {
    const appScope = scope();
    const source = store(1);
    const values: unknown[] = [];
    const model = owner((dispose) => {
      onCleanup(() => {
        values.push("disposed");
      });

      const doubled = source.map((value) => value * 2);

      reaction({
        on: doubled,
        run: (value: number) => {
          values.push(["reaction", value]);
        },
      });

      source.subscribe((value) => {
        values.push(["subscription", value]);
      });

      return { dispose };
    });

    await run({ unit: source.node, payload: 2, scope: appScope });
    model.dispose();
    await run({ unit: source.node, payload: 3, scope: appScope });

    expect(values).toEqual([["subscription", 2], ["reaction", 4], "disposed"]);
  });

  it("reuses an explicit owner through withOwner", () => {
    const values: string[] = [];

    const model = owner((dispose, owner) => {
      return { dispose, owner };
    });

    withOwner(model.owner, () => {
      expect(getOwner()).toBe(model.owner);
      onCleanup(() => {
        values.push("cleanup");
      });
    });

    expect(getOwner()).toBeNull();

    model.dispose();

    expect(values).toEqual(["cleanup"]);
  });

  it("runs a cleanup immediately when registered into a disposed owner", () => {
    const values: string[] = [];
    const model = owner((dispose, owner) => ({ dispose, owner }));

    model.dispose();
    withOwner(model.owner, () => {
      onCleanup(() => {
        values.push("late-cleanup");
      });
    });

    expect(values).toEqual(["late-cleanup"]);
  });

  it("adds disposable methods to the returned model root", () => {
    const values: string[] = [];
    const model = owner(() => {
      onCleanup(() => {
        values.push("cleanup");
      });

      return { value: 1 };
    });

    expect(typeof model.dispose).toBe("function");
    expect(typeof model[Symbol.dispose]).toBe("function");
    expect(Object.keys(model)).toEqual(["value"]);

    model[Symbol.dispose]();
    model.dispose();

    expect(values).toEqual(["cleanup"]);
  });

  it("stops a reaction it owns on dispose", async () => {
    const a = scope();
    const s = store(0);
    const seen: number[] = [];

    const app = owner(() => scoped(a, () => reaction(() => seen.push(s.value))));

    expect(seen).toEqual([0]);
    expect(nextOf(s.node)).toContain(app.node);

    app.dispose();

    await run({ unit: s.node, payload: 5, scope: a });
    expect(seen).toEqual([0]); // owner cleanup fired stop()
    expect(nextOf(s.node)).not.toContain(app.node);
  });

  it("can be created without an active owner, then stopped", async () => {
    const a = scope();
    const s = store(0);
    const seen: number[] = [];

    const r = reaction({ scope: a, run: () => seen.push(s.value) });

    expect(seen).toEqual([0]);
    r.stop();
    await run({ unit: s.node, payload: 1, scope: a });
    expect(seen).toEqual([0]);
  });
});
