import { afterEach, describe, expect, it } from "vitest";
import { computed, effect, reaction, scope, scoped, store } from "../../lib";
import type { Node } from "../../lib";
import { collectNodes, isTracking, run, trackNode } from "../../lib/internal";
import { getActiveScope, setActiveScope } from "../../lib/scope/internal";
import {
  createMicroScope,
  isMicroScope,
  readMicroDependencies,
} from "../../lib/scope/micro";
import {
  getScopedObservers,
  reconcileScopedEdges,
} from "../../lib/kernel/scoped-edges";
import { mkNode } from "../support/graph-helpers";

// These tests directly manipulate the ambient scope / module-global collector,
// so reset the ambient scope after every test to prevent cross-test leakage.
afterEach(() => {
  setActiveScope(null);
});

// Flush all pending microtasks/effect settlements to quiescence. This is a
// drain-to-idle helper, not a timing race: the setTimeout(0) boundary simply
// guarantees every already-queued microtask and pending promise has settled.
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("collectNodes", () => {
  it("captures a directly tracked node", () => {
    const n = mkNode("n");
    const { nodes } = collectNodes(() => trackNode(n));

    expect(nodes).toBeInstanceOf(Set);
    expect(nodes.size).toBe(1);
    expect(nodes.has(n)).toBe(true);
  });

  it("returns the callback result alongside the collected nodes", () => {
    const n = mkNode("n");
    const { result, nodes } = collectNodes(() => {
      trackNode(n);
      return 42;
    });

    expect(result).toBe(42);
    expect(nodes.has(n)).toBe(true);
  });

  it("dedups repeated reads of the same node to a single entry", () => {
    const n = mkNode("n");
    const { nodes } = collectNodes(() => {
      trackNode(n);
      trackNode(n);
      trackNode(n);
    });

    expect(nodes.size).toBe(1);
    expect(nodes.has(n)).toBe(true);
  });

  it("yields an empty node set when the window tracks nothing", () => {
    const { result, nodes } = collectNodes(() => "x");

    expect(result).toBe("x");
    expect(nodes.size).toBe(0);
  });

  it("preserves first-read insertion order in the returned set", () => {
    const n1 = mkNode("n1");
    const n2 = mkNode("n2");
    const n3 = mkNode("n3");

    const { nodes } = collectNodes(() => {
      trackNode(n3);
      trackNode(n1);
      trackNode(n2);
      trackNode(n1); // re-read must not reorder
    });

    expect([...nodes]).toEqual([n3, n1, n2]);
  });

  it("restores a null collector after the outermost window closes", () => {
    setActiveScope(null);
    expect(isTracking()).toBe(false);

    collectNodes(() => trackNode(mkNode("n")));

    // With a null ambient scope, isTracking() can only be true if a collector
    // is still installed — proving strict LIFO restore to null.
    expect(isTracking()).toBe(false);
  });

  it("captures only its own node in each of three nested windows", () => {
    const a = mkNode("a");
    const b = mkNode("b");
    const c = mkNode("c");

    let inner!: { nodes: Set<Node> };
    let middle!: { nodes: Set<Node> };

    const outer = collectNodes(() => {
      trackNode(a);
      middle = collectNodes(() => {
        trackNode(b);
        inner = collectNodes(() => trackNode(c));
      });
    });

    expect([...outer.nodes]).toEqual([a]);
    expect([...middle.nodes]).toEqual([b]);
    expect([...inner.nodes]).toEqual([c]);
    expect(isTracking()).toBe(false);
  });

  it("re-throws a throwing callback while still restoring the collector", () => {
    setActiveScope(null);
    const n = mkNode("n");

    expect(() =>
      collectNodes(() => {
        trackNode(n);
        throw new Error("boom");
      }),
    ).toThrow("boom");

    // No dangling collector: a later top-level trackNode is a no-op and a fresh
    // window still works.
    expect(isTracking()).toBe(false);
    const { nodes } = collectNodes(() => trackNode(mkNode("m")));
    expect(nodes.size).toBe(1);
  });

  it("resumes the outer window after an inner window throws", () => {
    const outer1 = mkNode("outer1");
    const outer2 = mkNode("outer2");
    const innerOnly = mkNode("innerOnly");

    const { nodes } = collectNodes(() => {
      trackNode(outer1);

      try {
        collectNodes(() => {
          trackNode(innerOnly);
          throw new Error("inner-boom");
        });
      } catch {
        // swallow: the outer window must survive intact.
      }

      trackNode(outer2);
    });

    expect(nodes.has(outer1)).toBe(true);
    expect(nodes.has(outer2)).toBe(true);
    expect(nodes.has(innerOnly)).toBe(false);
  });

  it("excludes an inner window's reads from the outer set", () => {
    const nA = mkNode("nA");
    const nB = mkNode("nB");
    const nC = mkNode("nC");

    let innerNodes!: Set<Node>;
    const outer = collectNodes(() => {
      trackNode(nA);
      innerNodes = collectNodes(() => trackNode(nB)).nodes;
      trackNode(nC); // outer resumes after inner exits
    });

    expect([...outer.nodes]).toEqual([nA, nC]);
    expect([...innerNodes]).toEqual([nB]);
    expect(outer.nodes.has(nB)).toBe(false);
  });
});

describe("trackNode", () => {
  it("is a silent no-op with a null scope and no collector", () => {
    setActiveScope(null);
    const n = mkNode("n");

    expect(() => trackNode(n)).not.toThrow();
    expect(isTracking()).toBe(false);
    // The collector slot is untouched — a fresh window still captures cleanly.
    expect(collectNodes(() => trackNode(n)).nodes.has(n)).toBe(true);
  });

  it("registers no dependency under a real non-micro scope", () => {
    const real = scope();
    setActiveScope(real);
    const n = mkNode("n");

    trackNode(n);

    expect(isTracking()).toBe(false);
    // A real scope has no micro dependency accumulator.
    expect(readMicroDependencies(real)).toBeUndefined();
  });

  it("routes a direct read under a micro-scope into that scope's dependencies", () => {
    const real = scope();
    const micro = createMicroScope(real);
    setActiveScope(micro);
    const n = mkNode("n");

    trackNode(n);

    const deps = readMicroDependencies(micro);
    expect(deps).toBeDefined();
    expect(deps?.has(n)).toBe(true);
  });

  it("routes to the collector ahead of an ambient micro-scope", () => {
    const real = scope();
    const micro = createMicroScope(real);
    setActiveScope(micro);
    const n = mkNode("n");

    const { nodes } = collectNodes(() => trackNode(n));

    expect(nodes.has(n)).toBe(true);
    // n must NOT be double-registered on the micro-scope's deps.
    expect(readMicroDependencies(micro)?.size ?? 0).toBe(0);
  });

  it("resumes micro-scope routing after a nested collector window closes", () => {
    const real = scope();
    const micro = createMicroScope(real);
    setActiveScope(micro);
    const inWindow = mkNode("inWindow");
    const afterWindow = mkNode("afterWindow");

    collectNodes(() => trackNode(inWindow));
    trackNode(afterWindow); // no collector now → routes to micro

    const deps = readMicroDependencies(micro);
    expect(deps?.has(afterWindow)).toBe(true);
    expect(deps?.has(inWindow)).toBe(false);
  });

  it("keeps two micro-scopes' dependency sets independent for a shared node", () => {
    const realA = scope();
    const realB = scope();
    const micro1 = createMicroScope(realA);
    const micro2 = createMicroScope(realB);
    const shared = mkNode("shared");
    const onlyOne = mkNode("onlyOne");

    setActiveScope(micro1);
    trackNode(shared);
    setActiveScope(micro2);
    trackNode(shared);

    expect(readMicroDependencies(micro1)?.has(shared)).toBe(true);
    expect(readMicroDependencies(micro2)?.has(shared)).toBe(true);

    // Adding to micro1 does not appear in micro2.
    setActiveScope(micro1);
    trackNode(onlyOne);
    expect(readMicroDependencies(micro1)?.has(onlyOne)).toBe(true);
    expect(readMicroDependencies(micro2)?.has(onlyOne)).toBe(false);
  });
});

describe("isTracking", () => {
  it("is true inside a collector window even with a null scope", () => {
    setActiveScope(null);
    const seen: boolean[] = [];

    collectNodes(() => {
      seen.push(isTracking());
    });

    expect(seen).toEqual([true]);
  });

  it("is true under a micro-scope with no collector", () => {
    const real = scope();
    setActiveScope(createMicroScope(real));

    expect(isTracking()).toBe(true);
  });

  it("is false under a real scope with no collector", () => {
    setActiveScope(scope());

    expect(isTracking()).toBe(false);
  });

  it("is false with a null scope and no collector", () => {
    setActiveScope(null);

    expect(isTracking()).toBe(false);
  });

  it("transitions from micro to collector to micro across a window", () => {
    const real = scope();
    setActiveScope(createMicroScope(real));

    expect(isTracking()).toBe(true); // micro
    collectNodes(() => {
      expect(isTracking()).toBe(true); // collector
    });
    expect(isTracking()).toBe(true); // micro again (LIFO restore keeps ambient scope)
  });

  it("stays true across an await inside an async reaction", async () => {
    const appScope = scope();
    const fx = effect(async () => undefined);
    const before: boolean[] = [];
    const after: boolean[] = [];

    scoped(appScope, () => {
      reaction(async () => {
        before.push(isTracking());
        await fx();
        after.push(isTracking());
      });
    });

    await tick();

    expect(before).toEqual([true]);
    expect(after).toEqual([true]);
  });

  it("gates a fine-grained reader's key-node build", () => {
    const fieldNode = mkNode("field");
    let builds = 0;

    // A minimal fine-grained store: it only pays to build/track a per-keypath
    // node when someone is tracking (the isTracking() gate).
    const readField = (): number => {
      if (isTracking()) {
        builds += 1;
        trackNode(fieldNode);
      }
      return 42;
    };

    // Plain read, no reaction/collector active — the gate is closed.
    setActiveScope(scope());
    expect(readField()).toBe(42);
    expect(builds).toBe(0);

    // Read inside a tracking window — the gate opens and the key node is tracked.
    const { nodes } = collectNodes(() => readField());
    expect(builds).toBe(1);
    expect(nodes.has(fieldNode)).toBe(true);
  });
});

describe("reconcileScopedEdges", () => {
  it("drops a self-edge from the observer set", () => {
    const s = scope();
    const dependent = mkNode("dependent");
    const other = mkNode("other");

    reconcileScopedEdges(s, dependent, [dependent, other]);

    // The dependent never observes itself.
    expect(getScopedObservers(s, dependent)).toBeUndefined();
    expect([...(getScopedObservers(s, other) ?? [])]).toEqual([dependent]);
  });
});

describe("reaction dependencies", () => {
  it("hold only a read computed, not the computed's own source", async () => {
    const appScope = scope();
    const base = store(1);
    const doubled = computed(() => base.value * 2);
    const other = store(100);
    const seen: number[] = [];
    let r!: ReturnType<typeof reaction>;

    scoped(appScope, () => {
      r = reaction(() => {
        seen.push(doubled.value);
      });
    });

    expect(seen).toEqual([2]);

    // The reaction's own dependency set is exactly {doubled}, not {base}.
    const deps = r.dependencies();
    expect(deps).toContain(doubled.node);
    expect(deps).not.toContain(base.node);
    expect(deps).not.toContain(other.node);

    // Changing the computed's source re-runs (through the computed)...
    await run({ unit: base.node, payload: 5, scope: appScope });
    expect(seen).toEqual([2, 10]);

    // ...changing an unrelated store does not.
    await run({ unit: other.node, payload: 200, scope: appScope });
    expect(seen).toEqual([2, 10]);
  });

  it("exclude a store read inside an effect handler", async () => {
    const appScope = scope();
    const a = store(0);
    const s = store(100);
    const runs: number[] = [];
    const fx = effect(async () => {
      // Read inside the handler — must NOT be attributed to the reaction.
      void s.value;
    });

    scoped(appScope, () => {
      reaction(async () => {
        const av = a.value; // the only real dependency
        await fx();
        runs.push(av);
      });
    });

    await tick();
    expect(runs).toEqual([0]);

    // Changing `s` (read only inside the effect handler) must NOT re-run.
    await run({ unit: s.node, payload: 1, scope: appScope });
    await tick();
    expect(runs).toEqual([0]);

    // Changing `a` (a real dependency) does re-run.
    await run({ unit: a.node, payload: 7, scope: appScope });
    await tick();
    expect(runs).toEqual([0, 7]);
  });

  it("skip reads made while an effect handler runs under the unwrapped scope", async () => {
    const appScope = scope();
    const dep = store(0);
    const other = store(0);
    const capturedScope: Array<ReturnType<typeof getActiveScope>> = [];
    const capturedTracking: boolean[] = [];
    const capturedMicro: boolean[] = [];
    const seen: number[] = [];

    const fx = effect(() => {
      capturedScope.push(getActiveScope());
      capturedTracking.push(isTracking());
      capturedMicro.push(isMicroScope(getActiveScope()));
      // Untracked read inside the handler.
      void other.value;
    });

    scoped(appScope, () => {
      reaction(() => {
        seen.push(dep.value);
        void fx();
      });
    });

    await tick();

    expect(capturedScope[0]).toBe(appScope); // real scope, not a micro overlay
    expect(capturedMicro[0]).toBe(false);
    expect(capturedTracking[0]).toBe(false); // handler reads are untracked

    // `other`, read only in the handler, never became a reaction dependency.
    const before = seen.length;
    await run({ unit: other.node, payload: 99, scope: appScope });
    await tick();
    expect(seen.length).toBe(before);

    // `dep`, read directly in the reaction body, still drives re-runs.
    await run({ unit: dep.node, payload: 5, scope: appScope });
    await tick();
    expect(seen).toContain(5);
  });

  it("include a store first read only after an await", async () => {
    const appScope = scope();
    const a = store(1);
    const b = store(10);
    const fx = effect(async () => undefined);
    const seen: number[] = [];

    scoped(appScope, () => {
      reaction(async () => {
        const av = a.value; // pre-await dependency
        await fx();
        seen.push(av + b.value); // b is first read only post-await
      });
    });

    await tick();
    expect(seen).toEqual([11]);

    // A post-await-only dependency change re-runs it (tracking survived the await).
    await run({ unit: b.node, payload: 20, scope: appScope });
    await tick();
    expect(seen).toEqual([11, 21]);
  });

  it("attach one edge for a node read on both sides of an await", async () => {
    const appScope = scope();
    const s = store(1);
    const fx = effect(async () => undefined);
    let r!: ReturnType<typeof reaction>;

    scoped(appScope, () => {
      r = reaction(async () => {
        void s.value; // pre-await
        await fx();
        void s.value; // post-await (same node)
      });
    });

    await tick();

    // Global-edge auto reaction: s appears exactly once in its dependency set...
    expect(r.dependencies().filter((n) => n === s.node)).toHaveLength(1);
    // ...and s's static `next` holds the reaction node exactly once (attach dedup).
    expect((s.node.next ?? []).filter((n) => n === r.node)).toHaveLength(1);
  });

  it("dedup a repeated same-source read into one attach", async () => {
    const appScope = scope();
    const s = store(0);
    let r!: ReturnType<typeof reaction>;

    scoped(appScope, () => {
      r = reaction(() => {
        // Read the same source twice in one body.
        void s.value;
        void s.value;
      });
    });

    // Re-run once more.
    await run({ unit: s.node, payload: 1, scope: appScope });

    expect((s.node.next ?? []).filter((n) => n === r.node)).toHaveLength(1);
    expect(r.dependencies().filter((n) => n === s.node)).toHaveLength(1);
  });

  it("detach the old branch source and attach the new one", async () => {
    const s = scope();
    const useLeft = store(true);
    const left = store(1);
    const right = store(2);
    const seen: number[] = [];
    let r!: ReturnType<typeof reaction>;

    r = reaction({
      scope: s,
      run() {
        seen.push(useLeft.value ? left.value : right.value);
      },
    });

    // Initially reads {useLeft, left}.
    expect(getScopedObservers(s, left.node)?.has(r.node)).toBe(true);
    expect(getScopedObservers(s, right.node)?.has(r.node) ?? false).toBe(false);

    // Flip the branch.
    await run({ unit: useLeft.node, payload: false, scope: s });

    // Now reads {useLeft, right}; the left edge is detached.
    expect(getScopedObservers(s, right.node)?.has(r.node)).toBe(true);
    expect(getScopedObservers(s, left.node)?.has(r.node) ?? false).toBe(false);
  });

  it("detach every source when a re-run reads nothing", async () => {
    const appScope = scope();
    const s = store(0);
    const seen: number[] = [];
    let readIt = true;
    let r!: ReturnType<typeof reaction>;

    scoped(appScope, () => {
      r = reaction(() => {
        seen.push(readIt ? s.value : -1);
      });
    });

    expect(seen).toEqual([0]);
    expect(r.dependencies()).toContain(s.node);

    // Flip so the next run reads nothing, then trigger the (still-subscribed) rerun.
    readIt = false;
    await run({ unit: s.node, payload: 1, scope: appScope });

    expect(seen).toEqual([0, -1]);
    expect(r.dependencies()).toEqual([]); // all deps detached

    // A further change no longer re-runs it.
    await run({ unit: s.node, payload: 2, scope: appScope });
    expect(seen).toEqual([0, -1]);
  });

  it("never accumulate stale edges across repeated runs", async () => {
    const appScope = scope();
    const sel = store(true);
    const a = store(1);
    const b = store(2);
    const seen: number[] = [];
    let r!: ReturnType<typeof reaction>;

    scoped(appScope, () => {
      r = reaction(() => {
        seen.push(sel.value ? a.value : b.value);
      });
    });

    // {sel, a}
    expect(r.dependencies()).toHaveLength(2);

    await run({ unit: sel.node, payload: false, scope: appScope }); // {sel, b}
    expect(r.dependencies()).toHaveLength(2);

    await run({ unit: sel.node, payload: true, scope: appScope }); // {sel, a}
    expect(r.dependencies()).toHaveLength(2);

    // The dependency set never grew with run count.
    expect(new Set(r.dependencies()).size).toBe(2);
  });

  it("stay isolated per scope when a per-scope reaction reads different branches", async () => {
    const a = scope();
    const b = scope();
    const useLeft = store(true);
    const left = store(1);
    const right = store(2);

    const r = reaction({
      scope: [a, b],
      run() {
        void (useLeft.value ? left.value : right.value);
      },
    });

    // Creation seeds edges only in the first configured scope (a), reading
    // {useLeft, left}. Move b's committed branch to `right`, then bootstrap the
    // reaction's b-edges by running it in b (a multi-scope auto reaction does not
    // self-bootstrap in non-first scopes — see suspectedBugs).
    await run({ unit: useLeft.node, payload: false, scope: b });
    await run({ unit: r.node, scope: b });

    expect(getScopedObservers(a, left.node)?.has(r.node)).toBe(true);
    expect(getScopedObservers(a, right.node)?.has(r.node) ?? false).toBe(false);
    expect(getScopedObservers(b, right.node)?.has(r.node)).toBe(true);
    expect(getScopedObservers(b, left.node)?.has(r.node) ?? false).toBe(false);
  });

  it("clear from every source when a per-scope reaction stops", () => {
    const s = scope();
    const src = store(0);
    const r = reaction({
      scope: s,
      run() {
        void src.value;
      },
    });

    expect(getScopedObservers(s, src.node)?.has(r.node)).toBe(true);

    r.stop();

    expect(getScopedObservers(s, src.node)).toBeUndefined();
  });

  it("reject a stale async run's commit over a newer run", async () => {
    const appScope = scope();
    const which = store<"A" | "B">("A");
    const A = store(1);
    const B = store(2);
    const seen: number[] = [];

    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const gate1 = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const gate2 = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    let call = 0;
    const fx = effect(async () => {
      const c = ++call;
      await (c === 1 ? gate1 : gate2);
    });

    let r!: ReturnType<typeof reaction>;
    scoped(appScope, () => {
      r = reaction(async () => {
        const branch = which.value; // dep
        const value = branch === "A" ? A.value : B.value; // dep A or B
        await fx();
        seen.push(value);
      });
    });

    // run1 (creation) is now blocked on gate1, having read {which:A, A}. It has
    // NOT committed its deps yet (auto reactions commit only after settling).
    await tick();
    expect(call).toBe(1);

    // Move the committed `which` value to "B" without any subscribed observers.
    await run({ unit: which.node, payload: "B", scope: appScope });

    // Force run2 directly (run1 hasn't subscribed anything yet). run2 reads
    // {which:B, B}, blocks on gate2, and takes over the scope's run token.
    void run({ unit: r.node, scope: appScope });
    await tick();
    expect(call).toBe(2);

    // Newest run settles first and commits {which, B}.
    releaseSecond();
    await tick();

    // Stale run settles last; its commit must be skipped (token no longer matches).
    releaseFirst();
    await tick();

    const deps = r.dependencies();
    expect(deps).toContain(which.node);
    expect(deps).toContain(B.node);
    expect(deps).not.toContain(A.node);

    // Behavioral confirmation: B drives re-runs, A does not.
    const beforeA = seen.length;
    await run({ unit: A.node, payload: 99, scope: appScope });
    await tick();
    expect(seen.length).toBe(beforeA);

    await run({ unit: B.node, payload: 42, scope: appScope });
    await tick();
    expect(seen).toContain(42);
  });
});

describe("a computed", () => {
  it("keeps outer dependencies shallow through a computed-of-computed", () => {
    const s = scope();
    const base = store(1);
    const inner = computed(() => base.value + 0);
    const outer = computed(() => inner.value + 1);

    expect(scoped(s, () => outer.value)).toBe(2);

    // base is observed by exactly one dependent (inner's invalidator). If the
    // outer window had leaked base, base would have two observers.
    expect(getScopedObservers(s, base.node)?.size).toBe(1);
    // inner is observed by exactly one dependent (outer's invalidator).
    expect(getScopedObservers(s, inner.node)?.size).toBe(1);
  });

  it("throws a cycle error when it reads its own value", () => {
    const s = scope();
    const selfRef: { value: number } = computed(() => selfRef.value + 1);

    setActiveScope(null);
    expect(() => scoped(s, () => selfRef.value)).toThrow("Computed cycle detected");

    // The collectNodes finally block ran, so no collector leaked globally.
    setActiveScope(null);
    expect(isTracking()).toBe(false);
  });
});
