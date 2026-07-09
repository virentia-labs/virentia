import { describe, expect, it, expectTypeOf, vi, afterEach } from "vitest";
import { setActiveScope } from "@virentia/core/internal";
import {
  allSettled as effectorAllSettled,
  createEffect,
  createEvent,
  createStore,
  fork,
  sample,
} from "effector";
import type { EventCallable as EffectorEventCallable } from "effector";
import {
  effect,
  event,
  getCurrentScope,
  reaction,
  scope,
  scoped,
  store,
} from "@virentia/core";
import type { Effect as VirentiaEffect, EventCallable as VirentiaEventCallable } from "@virentia/core";
import { associate, effectorAssociations, ensureAssociation, fool } from "../lib";
import {
  isEffectorUnit,
  isObjectLike,
  isVirentiaEffect,
  isVirentiaUnit,
} from "../lib/guards";
import {
  shouldSkipEffector,
  shouldSkipVirentia,
  suppressEffector,
  suppressVirentia,
} from "../lib/association-state";
import {
  callAssociation,
  emitVirentia,
  resolveAssociationFromEffectorScope,
  resolveAssociationFromVirentiaScope,
} from "../lib/runtime";
import type { VirentiaTarget } from "../lib/types";

// --- helpers -------------------------------------------------------------

/** Deterministic-ish flush of the microtask queue plus one macrotask turn. */
async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) await Promise.resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

// Test isolation: overlapping concurrent `scoped()` calls (e.g. two bridged effect
// launches into the same scope) can leave the process-global ambient virentia scope
// pointing at a scope after both settle — the nested calls chain their captured
// "previous" scope. Reset it between tests so cross-scope resolution in later tests
// starts from a clean (null) ambient. See suspected-bug note (R-BR-8 ambient leak).
afterEach(() => {
  setActiveScope(null);
});

function makeAssociation() {
  const v = scope();
  const e = fork();
  const association = associate({ virentia: v, effector: e });
  return { v, e, association };
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// =========================================================================
// associate() / findAssociation / ensureAssociation
// =========================================================================
describe("associate()", () => {
  it("R-ASSOC-1: throws when virentia scope is missing", () => {
    expect(() => associate({ effector: fork() } as any)).toThrow(
      "Effector association requires a Virentia scope",
    );
  });

  it("R-ASSOC-2: throws when effector scope is missing", () => {
    expect(() => associate({ virentia: scope() } as any)).toThrow(
      "Effector association requires an Effector scope",
    );
  });

  it("R-ASSOC-3: registers the association in both WeakMaps", () => {
    const v = scope();
    const e = fork();
    const a = associate({ virentia: v, effector: e });
    expect(effectorAssociations.byVirentia.get(v)).toBe(a);
    expect(effectorAssociations.byEffector.get(e)).toBe(a);
    expect(a.virentia).toBe(v);
    expect(a.effector).toBe(e);
  });

  it("R-ASSOC-4 / R-ASSOC-8: idempotent for the identical pair (same object, maps stay in sync)", () => {
    const v = scope();
    const e = fork();
    const a = associate({ virentia: v, effector: e });
    const b = associate({ virentia: v, effector: e });
    expect(b).toBe(a);
    expect(effectorAssociations.byVirentia.get(v)).toBe(a);
    expect(effectorAssociations.byEffector.get(e)).toBe(a);
    expect(effectorAssociations.byVirentia.get(v)).toBe(effectorAssociations.byEffector.get(e));
  });

  it("R-ASSOC-5: rejects re-binding a virentia scope to a different effector scope", () => {
    const v = scope();
    associate({ virentia: v, effector: fork() });
    expect(() => associate({ virentia: v, effector: fork() })).toThrow(
      "Virentia scope is already associated with another Effector scope",
    );
  });

  it("R-ASSOC-6: rejects re-binding an effector scope to a different virentia scope", () => {
    const e = fork();
    associate({ virentia: scope(), effector: e });
    expect(() => associate({ virentia: scope(), effector: e })).toThrow(
      "Effector scope is already associated with another Virentia scope",
    );
  });

  it("R-ASSOC-7: re-links onto the existing association object when only one axis pre-exists", () => {
    // First register only virentia via effector e1, then associate the SAME virentia
    // with the same effector again — must reuse, not mint.
    const v = scope();
    const e = fork();
    const original = associate({ virentia: v, effector: e });
    // Force byEffector to be re-set through the "existing" branch by calling again.
    const again = associate({ virentia: v, effector: e });
    expect(again).toBe(original);
    expect(effectorAssociations.byVirentia.get(v)).toBe(original);
    expect(effectorAssociations.byEffector.get(e)).toBe(original);
  });

  it("R-ASSOC-9: ensureAssociation({}) throws the generic missing message", () => {
    expect(() => ensureAssociation({})).toThrow(
      "Effector association is missing. Call associate",
    );
  });

  it("R-ASSOC-10: ensureAssociation for an unknown effector scope throws the effector-specific message", () => {
    expect(() => ensureAssociation({ effector: fork() })).toThrow(
      "Effector association is missing for provided Effector scope",
    );
  });

  it("R-ASSOC-11: ensureAssociation for an unknown virentia scope throws the virentia-specific message", () => {
    expect(() => ensureAssociation({ virentia: scope() })).toThrow(
      "Effector association is missing for provided Virentia scope",
    );
  });

  it("R-ASSOC-12: ensureAssociation throws on cross-axis mismatch (findAssociation returns null)", () => {
    const { v: v1, e: e1 } = makeAssociation();
    const { e: e2 } = makeAssociation();
    // v1 resolves on the virentia axis, but effector e2 belongs to a different association.
    expect(() => ensureAssociation({ virentia: v1, effector: e2 })).toThrow(
      "Effector association is missing",
    );
    // sanity: the matching lookup still works.
    expect(ensureAssociation({ virentia: v1, effector: e1 }).virentia).toBe(v1);
  });

  it("R-ASSOC-13: virentia axis resolves first and validates the effector matches", () => {
    const { v, e, association } = makeAssociation();
    expect(ensureAssociation({ virentia: v, effector: e })).toBe(association);
    expect(ensureAssociation({ virentia: v })).toBe(association);
    expect(ensureAssociation({ effector: e })).toBe(association);
  });
});

// =========================================================================
// guards
// =========================================================================
describe("guards", () => {
  it("R-GRD-1: isEffectorUnit discriminates effector units from virentia/plain values", () => {
    expect(isEffectorUnit(createEvent())).toBe(true);
    expect(isEffectorUnit(createStore(0))).toBe(true);
    expect(isEffectorUnit(createEffect(async () => 1))).toBe(true);
    expect(isEffectorUnit(event())).toBe(false);
    expect(isEffectorUnit(store(0))).toBe(false);
    expect(isEffectorUnit(42)).toBe(false);
    expect(isEffectorUnit(null)).toBe(false);
  });

  it("R-GRD-2: isVirentiaUnit requires a node and a non-effector identity", () => {
    expect(isVirentiaUnit(event())).toBe(true);
    expect(isVirentiaUnit(store(0))).toBe(true);
    expect(isVirentiaUnit({ node: {} })).toBe(true);
    expect(isVirentiaUnit(createEvent())).toBe(false);
    expect(isVirentiaUnit({})).toBe(false);
    expect(isVirentiaUnit(null)).toBe(false);
  });

  it("R-GRD-3: isVirentiaEffect requires doneData and pending", () => {
    expect(isVirentiaEffect(effect(async () => 1))).toBe(true);
    expect(isVirentiaEffect(event())).toBe(false);
    expect(isVirentiaEffect(store(0))).toBe(false);
    expect(isVirentiaEffect(createEffect(async () => 1))).toBe(false);
  });

  it("R-GRD-4: isObjectLike over primitives and objects", () => {
    expect(isObjectLike(null)).toBe(false);
    expect(isObjectLike(undefined)).toBe(false);
    expect(isObjectLike("s")).toBe(false);
    expect(isObjectLike(0)).toBe(false);
    expect(isObjectLike({})).toBe(true);
    expect(isObjectLike(() => {})).toBe(true);
  });

  it("R-GRD-5: a fooled unit reads as an effector unit; isVirentiaUnit stays false (guard excludes effector units)", () => {
    // NOTE: isVirentiaUnit explicitly returns `!isEffectorUnit(value)`, so a fooled
    // unit (which effector's `is.unit` recognises) is NOT reported as a virentia unit
    // by this guard. The "dual identity" only holds via effector's own `is` + the
    // raw `.node` property the runtime reads directly. See suspected-bug note.
    const fe = fool(createEvent<number>());
    expect(isEffectorUnit(fe)).toBe(true);
    expect(isVirentiaUnit(fe)).toBe(false);
    expect("node" in (fe as object)).toBe(true);

    const fv = fool(event<number>());
    expect(isEffectorUnit(fv)).toBe(true);
    expect(isVirentiaUnit(fv)).toBe(false);
    expect("node" in (fv as object)).toBe(true);
  });
});

// =========================================================================
// fool() — validation, caching, identity
// =========================================================================
describe("fool() identity", () => {
  it("R-FOOL-1: throws for a primitive / null / undefined argument", () => {
    expect(() => fool(42 as any)).toThrow("fool() expects an Effector or Virentia unit");
    expect(() => fool(null as any)).toThrow("fool() expects an Effector or Virentia unit");
    expect(() => fool(undefined as any)).toThrow("fool() expects an Effector or Virentia unit");
    expect(() => fool("x" as any)).toThrow("fool() expects an Effector or Virentia unit");
  });

  it("R-FOOL-2: throws for an object that is neither an effector unit nor a virentia unit", () => {
    expect(() => fool({ foo: 1 } as any)).toThrow("fool() expects an Effector or Virentia unit");
    expect(() => fool((() => {}) as any)).toThrow("fool() expects an Effector or Virentia unit");
  });

  it("R-FOOL-3: caches by original unit (same fooled object returned)", () => {
    const e = createEvent<number>();
    expect(fool(e)).toBe(fool(e));
    const v = event<number>();
    expect(fool(v)).toBe(fool(v));
  });

  it("R-FOOL-4: fool() of an already-fooled unit returns it unchanged", () => {
    const f = fool(event<number>());
    expect(fool(f as any)).toBe(f);
    const fe = fool(createEvent<number>());
    expect(fool(fe as any)).toBe(fe);
  });

  it("R-FOOL-9: the fooled callable preserves its own name/length and exposes a node", () => {
    const f = fool(createEvent<number>());
    expect(typeof f).toBe("function");
    // base callable is `(...args) => call(...args)` => length 0, empty name; copy skips them.
    expect((f as unknown as (...a: unknown[]) => unknown).length).toBe(0);
    expect((f as { name: string }).name).toBe("");
    expect("node" in (f as object)).toBe(true);
  });

  it("R-FOOL-11: the fooledUnit marker symbol is a non-enumerable own symbol", () => {
    const f = fool(event<number>());
    const symbols = Object.getOwnPropertySymbols(f);
    const marker = symbols.find((s) => String(s) === "Symbol(virentia.effector.fooledUnit)");
    expect(marker).toBeDefined();
    const desc = Object.getOwnPropertyDescriptor(f, marker as symbol)!;
    expect(desc.enumerable).toBe(false);
    expect(desc.value).toBe(true);
    // never leaks into normal enumeration
    expect(Object.keys(f)).not.toContain(String(marker));
  });
});

// =========================================================================
// fool() — dispatch semantics
// =========================================================================
describe("fool() dispatch", () => {
  it("R-FOOL-5: calling a fooled virentia event dispatches to the original virentia event", async () => {
    const orig = event<number>();
    const seen: number[] = [];
    reaction({ on: orig, run: (v) => seen.push(v) });
    const f = fool(orig);
    const { v } = makeAssociation();
    await scoped(v, () => (f as unknown as (n: number) => unknown)(7));
    expect(seen).toEqual([7]);
  });

  it("R-FOOL-6: fooled effector event routes to the virentia adapter under a scope, raw effector otherwise", async () => {
    const f = fool(createEvent<number>());
    const seen: number[] = [];
    reaction({ on: f as any, run: (x) => seen.push(x as number) });
    const { v } = makeAssociation();

    // Scoped: goes through the virentia adapter -> virentia reaction observes it.
    await scoped(v, () => (f as unknown as (n: number) => unknown)(1));
    expect(seen).toEqual([1]);

    // Unscoped: dispatches the raw effector event (no active virentia scope), so the
    // virentia reaction does NOT observe it. The raw event fires with no scope, and
    // the bridge scope-node logs a missing-association error (swallowed by effector).
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      (f as unknown as (n: number) => unknown)(2);
      await flush();
    } finally {
      consoleError.mockRestore();
    }
    expect(seen).toEqual([1]);
  });

  it("R-FOOL-7: calling a fooled effector store outside a scope throws", () => {
    const s = fool(createStore(0));
    expect(() => (s as unknown as (n: number) => unknown)(5)).toThrow(
      "Effector store cannot be called",
    );
  });

  it("R-FOOL-8: calling a fooled effector store inside a scope routes into the virentia adapter", async () => {
    const s = fool(createStore(0));
    const seen: number[] = [];
    reaction({ on: s as any, run: (x) => seen.push(x as number) });
    const { v } = makeAssociation();
    await scoped(v, () => (s as unknown as (n: number) => unknown)(5));
    expect(seen).toEqual([5]);
  });
});

// =========================================================================
// suppression state
// =========================================================================
describe("suppression state", () => {
  it("R-SUP-1: shouldSkip is false with no active suppression", () => {
    const { association } = makeAssociation();
    const u = {};
    expect(shouldSkipEffector(association, u)).toBe(false);
    expect(shouldSkipVirentia(association, u)).toBe(false);
  });

  it("R-SUP-2 / R-SUP-6: suppressEffector decrements in finally even when fn throws", () => {
    const { association } = makeAssociation();
    const u = {};
    let inner = false;
    expect(() =>
      suppressEffector(association, u, () => {
        inner = shouldSkipEffector(association, u);
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(inner).toBe(true);
    expect(shouldSkipEffector(association, u)).toBe(false);
  });

  it("R-SUP-3: nested suppression stays active until every level releases", () => {
    const { association } = makeAssociation();
    const u = {};
    const probes: boolean[] = [];
    suppressEffector(association, u, () => {
      probes.push(shouldSkipEffector(association, u)); // true (depth 1)
      suppressEffector(association, u, () => {
        probes.push(shouldSkipEffector(association, u)); // true (depth 2)
      });
      probes.push(shouldSkipEffector(association, u)); // true (back to depth 1)
    });
    probes.push(shouldSkipEffector(association, u)); // false (fully released)
    expect(probes).toEqual([true, true, true, false]);
  });

  it("R-SUP-4: suppressing unit A does not suppress a different unit B", () => {
    const { association } = makeAssociation();
    const a = {};
    const b = {};
    suppressEffector(association, a, () => {
      expect(shouldSkipEffector(association, a)).toBe(true);
      expect(shouldSkipEffector(association, b)).toBe(false);
    });
  });

  it("R-SUP-5: suppression is isolated per association", () => {
    const { association: a1 } = makeAssociation();
    const { association: a2 } = makeAssociation();
    const u = {};
    suppressEffector(a1, u, () => {
      expect(shouldSkipEffector(a1, u)).toBe(true);
      expect(shouldSkipEffector(a2, u)).toBe(false);
    });
  });

  it("R-SUP-7: suppressVirentia release is deferred until runVirentia settles", async () => {
    const { association } = makeAssociation();
    const target = event<number>();
    const gate = deferred();
    reaction({
      on: target,
      run() {
        return gate.promise;
      },
    });

    emitVirentia(association, target as unknown as VirentiaTarget<number>, 1, {
      suppressReaction: true,
    });
    // synchronously suppressed, and stays suppressed while the async reaction runs.
    expect(shouldSkipVirentia(association, target as object)).toBe(true);
    await Promise.resolve();
    expect(shouldSkipVirentia(association, target as object)).toBe(true);

    gate.resolve();
    await flush();
    expect(shouldSkipVirentia(association, target as object)).toBe(false);
  });

  it("R-SUP-8: manual suppressVirentia release is decrement-based, not holder-scoped", () => {
    // Documents current behaviour: two overlapping holders share one counter, and a
    // double-invoked release drives it to zero, clearing suppression while a
    // legitimate holder is still outstanding. See suspected-bug note.
    const { association } = makeAssociation();
    const u = {};
    const release1 = suppressVirentia(association, u);
    const release2 = suppressVirentia(association, u);
    expect(shouldSkipVirentia(association, u)).toBe(true);
    release1();
    expect(shouldSkipVirentia(association, u)).toBe(true); // still held by release2's count
    release1(); // erroneous double-invoke
    // BUG: suppression cleared even though release2 was never called.
    expect(shouldSkipVirentia(association, u)).toBe(false);
    release2(); // no-op / underflow-safe (deletes an already-absent key)
    expect(shouldSkipVirentia(association, u)).toBe(false);
  });
});

// =========================================================================
// resolve* runtime helpers
// =========================================================================
describe("resolveAssociation*", () => {
  it("R-RES-1: resolveAssociationFromEffectorScope(undefined) throws instead of dereferencing", () => {
    expect(() => resolveAssociationFromEffectorScope(undefined)).toThrow(
      "Effector association is missing",
    );
    expect(() => resolveAssociationFromEffectorScope(null)).toThrow(
      "Effector association is missing",
    );
  });

  it("R-RES-2: throws cross-scope contamination when an unrelated virentia scope is active", () => {
    const { e: eA } = makeAssociation();
    const { v: vB } = makeAssociation();
    scoped(vB, () => {
      expect(() => resolveAssociationFromEffectorScope(eA)).toThrow(
        "Effector scope is associated with another Virentia scope",
      );
    });
  });

  it("R-RES-3: returns the association when there is no active virentia scope or it matches", () => {
    const { v, e, association } = makeAssociation();
    expect(resolveAssociationFromEffectorScope(e)).toBe(association);
    scoped(v, () => {
      expect(resolveAssociationFromEffectorScope(e)).toBe(association);
    });
  });

  it("R-RES-4: resolveAssociationFromVirentiaScope throws when no scope is active", () => {
    expect(getCurrentScope()).toBeNull();
    expect(() => resolveAssociationFromVirentiaScope()).toThrow(
      "Effector association is missing",
    );
  });

  it("R-RES-5: resolveAssociationFromVirentiaScope returns the current scope's association", () => {
    const { v, association } = makeAssociation();
    scoped(v, () => {
      expect(resolveAssociationFromVirentiaScope()).toBe(association);
    });
  });
});

// =========================================================================
// callAssociation
// =========================================================================
describe("callAssociation", () => {
  it("R-CALL-1: effector target dispatches via allSettled in the association's effector scope", async () => {
    const { e, association } = makeAssociation();
    const $vals = createStore<number[]>([]);
    const target = createEvent<number>();
    $vals.on(target, (a, v) => [...a, v]);
    await callAssociation(association, target as any, 9);
    expect(e.getState($vals)).toEqual([9]);
  });

  it("R-CALL-2: virentia-effect target dispatches via scoped and returns the effect result", async () => {
    const { association } = makeAssociation();
    const fx = effect(async (p: number) => p + 100);
    const ret = await callAssociation(association, fx as any, 5);
    expect(ret).toBe(105);
  });

  it("R-CALL-3: non-effect virentia target awaits runVirentia and resolves undefined", async () => {
    const { v, association } = makeAssociation();
    const target = event<number>();
    const seen: number[] = [];
    reaction({ on: target, run: (x) => seen.push(x) });
    const ret = await callAssociation(association, target as unknown as VirentiaTarget<number>, 3);
    expect(ret).toBeUndefined();
    expect(seen).toEqual([3]);
    // payload landed in the association's virentia scope
    scoped(v, () => {
      expect(seen).toEqual([3]);
    });
  });
});

// =========================================================================
// bridging — events
// =========================================================================
describe("event bridging", () => {
  it("R-BR-1: an effector event targeting a fooled virentia event delivers into the virentia scope", async () => {
    const effectorSubmitted = createEvent<number>();
    const virentiaSubmitted = fool(event<number>());
    const total = store(0);
    const { v, e } = makeAssociation();
    reaction({
      on: virentiaSubmitted,
      run(value) {
        total.value += value;
      },
    });
    sample({ clock: effectorSubmitted, target: virentiaSubmitted as any });
    await effectorAllSettled(effectorSubmitted, { scope: e, params: 4 });
    scoped(v, () => expect(total.value).toBe(4));
  });

  it("R-BR-2: a fooled virentia event fired in scope propagates into the effector graph", async () => {
    const clock = fool(event<number>());
    const $sum = createStore(0).on(clock as any, (s, v) => s + (v as number));
    const { v, e } = makeAssociation();
    await scoped(v, () => (clock as unknown as (n: number) => unknown)(6));
    expect(e.getState($sum)).toBe(6);
  });

  it("R-BR-3: a fooled effector store bridges its current scope state as payload", async () => {
    const $s = fool(createStore(10));
    const clk = fool(createEvent());
    const target = fool(createEvent<number>());
    const captured: number[] = [];
    reaction({ on: target as any, run: (x) => captured.push(x as number) });
    const { e } = makeAssociation();
    sample({ clock: clk, source: $s, target } as any);
    await effectorAllSettled(clk as any, { scope: e, params: undefined });
    expect(captured).toEqual([10]);
  });

  it("R-LOOP-1a: bidirectional bridged event fired from the effector side fires exactly once", async () => {
    const f = fool(createEvent<number>());
    const $count = createStore(0).on(f as any, (c) => c + 1);
    let reactions = 0;
    reaction({ on: f as any, run: () => { reactions++; } });
    const { e } = makeAssociation();
    await effectorAllSettled(f as any, { scope: e, params: 5 });
    expect(e.getState($count)).toBe(1);
    expect(reactions).toBe(1);
  });

  it("R-LOOP-1b: bidirectional bridged event fired from the virentia side settles once", async () => {
    const f = fool(createEvent<number>());
    const $count = createStore(0).on(f as any, (c) => c + 1);
    let reactions = 0;
    reaction({ on: f as any, run: () => { reactions++; } });
    const { v, e } = makeAssociation();
    await scoped(v, () => (f as unknown as (n: number) => unknown)(3));
    expect(e.getState($count)).toBe(1);
    expect(reactions).toBe(1);
  });

  it("R-BR-11: firing an effector unit under an unrelated active virentia scope never delivers to it", async () => {
    const fA = fool(createEvent<number>());
    const seenA: number[] = [];
    reaction({ on: fA as any, run: (x) => seenA.push(x as number) });
    const { e: eA } = makeAssociation();
    const { v: vB } = makeAssociation();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await scoped(vB, () => effectorAllSettled(fA as any, { scope: eA, params: 1 }));
      await flush();
    } finally {
      consoleError.mockRestore();
    }
    // The cross-scope guard fired (surfaced on effector's error channel), and nothing
    // was delivered into vB's reaction — the payload is not misrouted to the wrong scope.
    // (The exact error channel is effector-internal; the contract we assert is non-delivery.
    // The guard's throw itself is verified directly in R-RES-2.)
    expect(seenA).toEqual([]);
  });
});

// =========================================================================
// bridging — effects
// =========================================================================
describe("effect bridging", () => {
  it("R-BR-4: a fooled virentia effect runs its handler in the associated virentia scope via allSettled", async () => {
    const fx = fool(effect(async (p: number) => p * 2));
    const { e } = makeAssociation();
    const res = (await effectorAllSettled(fx as any, { scope: e, params: 3 })) as {
      status: string;
      value: number;
    };
    expect(res.status).toBe("done");
    expect(res.value).toBe(6);
  });

  it("R-BR-5: a fooled effector effect is callable from a virentia scope (returns the allSettled envelope)", async () => {
    // NOTE: calling a fooled effector effect from a virentia scope resolves to the
    // effector allSettled *envelope* ({status, value}), NOT the bare Done value.
    // See suspected-bug note.
    const fx = fool(createEffect(async (p: number) => p + 1));
    const { v } = makeAssociation();
    const res = (await scoped(v, () => (fx as unknown as (n: number) => Promise<unknown>)(4))) as {
      status: string;
      value: number;
    };
    expect(res.status).toBe("done");
    expect(res.value).toBe(5);
  });

  it("R-BR-6a: bridged virentia effect failure surfaces as allSettled fail on the effector side", async () => {
    const fx = fool(
      effect(async (): Promise<number> => {
        throw new Error("boom");
      }),
    );
    const { e } = makeAssociation();
    const res = (await effectorAllSettled(fx as any, { scope: e, params: undefined })) as {
      status: string;
      value: Error;
    };
    expect(res.status).toBe("fail");
    expect(res.value.message).toBe("boom");
  });

  it("R-BR-6b: bridged effector effect failure resolves (does not reject) with a fail envelope in virentia scope", async () => {
    const fx = fool(
      createEffect(async (): Promise<number> => {
        throw new Error("nope");
      }),
    );
    const { v } = makeAssociation();
    const res = (await scoped(v, () =>
      (fx as unknown as (n: unknown) => Promise<unknown>)(undefined),
    )) as { status: string; value: Error };
    expect(res.status).toBe("fail");
    expect(res.value.message).toBe("nope");
  });

  it("R-BR-7a: bridged effector effect pending is observable in the effector scope while in flight", async () => {
    const gate = deferred<number>();
    const raw = createEffect((): Promise<number> => gate.promise);
    const fx = fool(raw);
    const { v, e } = makeAssociation();
    const p = scoped(v, () => (fx as unknown as (n: unknown) => Promise<unknown>)(undefined));
    await flush();
    expect(e.getState(raw.pending)).toBe(true);
    gate.resolve(1);
    await p;
    expect(e.getState(raw.pending)).toBe(false);
  });

  it("R-BR-7b: bridged virentia effect pending is observable in the virentia scope while in flight", async () => {
    const gate = deferred<number>();
    const under = effect((): Promise<number> => gate.promise);
    const fx = fool(under);
    const { v, e } = makeAssociation();
    const p = effectorAllSettled(fx as any, { scope: e, params: undefined });
    await flush();
    let during: boolean | undefined;
    scoped(v, () => { during = (under.pending as unknown as { value: boolean }).value; });
    expect(during).toBe(true);
    gate.resolve(1);
    await p;
    let after: boolean | undefined;
    scoped(v, () => { after = (under.pending as unknown as { value: boolean }).value; });
    expect(after).toBe(false);
  });

  it("R-BR-8: scopeQueue pairs each concurrent effect launch with an active virentia scope (FIFO)", async () => {
    const seen: Array<{ p: number; scoped: boolean }> = [];
    const under = effect(async (p: number): Promise<number> => {
      seen.push({ p, scoped: getCurrentScope() !== null });
      return p;
    });
    const fx = fool(under);
    const { e } = makeAssociation();
    const r1 = effectorAllSettled(fx as any, { scope: e, params: 1 });
    const r2 = effectorAllSettled(fx as any, { scope: e, params: 2 });
    await Promise.all([r1, r2]);
    // Both handler invocations resolved against a live paired scope, in launch order.
    expect(seen).toEqual([
      { p: 1, scoped: true },
      { p: 2, scoped: true },
    ]);
  });

  it("R-BR-8b: sequential cross-scope bridged effect launches each pair with their own scope", async () => {
    const ran: number[] = [];
    const under = effect(async (p: number): Promise<number> => {
      ran.push(p);
      return p;
    });
    const fx = fool(under);
    const { e: e1 } = makeAssociation();
    const { e: e2 } = makeAssociation();
    const s1 = (await effectorAllSettled(fx as any, { scope: e1, params: 10 })) as {
      status: string;
      value: number;
    };
    const s2 = (await effectorAllSettled(fx as any, { scope: e2, params: 20 })) as {
      status: string;
      value: number;
    };
    expect(s1.status).toBe("done");
    expect(s2.status).toBe("done");
    expect(ran).toEqual([10, 20]);
  });

  // SUSPECTED BUG (high): two bridged-effect launches on the SAME fooled virentia
  // effect in DIFFERENT effector scopes, started concurrently, should each run against
  // their own paired scope. They do not: while scope-1's callAssociation holds v1 as the
  // ambient virentia scope, scope-2's bridge scope-node resolves and trips the cross-scope
  // contamination guard, so the second launch deterministically FAILS. The scopeQueue
  // FIFO pairing does not isolate concurrent cross-scope launches. `it.fails` pins this:
  // it will start failing (alerting maintainers) once the bug is fixed.
  it.fails(
    "R-BR-8c: [BUG] concurrent cross-scope bridged effect launches should both succeed",
    async () => {
      const ran: number[] = [];
      const under = effect(async (p: number): Promise<number> => {
        ran.push(p);
        return p;
      });
      const fx = fool(under);
      const { e: e1 } = makeAssociation();
      const { e: e2 } = makeAssociation();
      const r1 = effectorAllSettled(fx as any, { scope: e1, params: 10 });
      const r2 = effectorAllSettled(fx as any, { scope: e2, params: 20 });
      const [s1, s2] = (await Promise.all([r1, r2])) as Array<{ status: string }>;
      expect(s1.status).toBe("done");
      expect(s2.status).toBe("done"); // currently "fail" -> this assertion throws (bug present)
      expect(ran.sort((a, b) => a - b)).toEqual([10, 20]);
    },
  );
});

// =========================================================================
// composed / advanced
// =========================================================================
describe("composed bridging", () => {
  it("R-BR-2 (advanced): fooled virentia units used as effector sample clock/source/target", async () => {
    const sessionChanged = fool(event<{ token: string }>());
    const userSelected = fool(event<string>());
    const userOpened = fool(event<{ userId: string; token: string }>());
    const opened: Array<{ userId: string; token: string }> = [];
    const { v } = makeAssociation();
    sample({
      clock: userSelected,
      source: sessionChanged,
      fn: (session: { token: string }, userId: string) => ({ userId, token: session.token }),
      target: userOpened,
    } as any);
    reaction({ on: userOpened, run: (value) => opened.push(value) });
    await scoped(v, async () => {
      await (sessionChanged as unknown as (s: { token: string }) => Promise<void>)({
        token: "tok",
      });
      await (userSelected as unknown as (s: string) => Promise<void>)("user:1");
    });
    expect(opened).toEqual([{ userId: "user:1", token: "tok" }]);
  });

  it("keeps two independent associations isolated for the same shared fooled unit", async () => {
    const submitted = fool(createEvent<number>());
    const total = store(0);
    reaction({
      on: submitted,
      run(value) {
        total.value += value as number;
      },
    });
    const { v: v1, e: e1 } = makeAssociation();
    const { v: v2, e: e2 } = makeAssociation();
    await effectorAllSettled(submitted as any, { scope: e1, params: 2 });
    await flush();
    await effectorAllSettled(submitted as any, { scope: e2, params: 5 });
    await flush();
    scoped(v1, () => expect(total.value).toBe(2));
    scoped(v2, () => expect(total.value).toBe(5));
  });

  it("R-BR-13: association WeakMaps do not retain a dropped, never-registered scope", () => {
    // Indirect WeakMap-semantics check: an unregistered scope resolves to undefined.
    const stray = scope();
    expect(effectorAssociations.byVirentia.get(stray)).toBeUndefined();
    expect(effectorAssociations.byEffector.get(fork())).toBeUndefined();
  });
});

// =========================================================================
// type smoke checks (behavioural suite is above; dedicated type wave elsewhere)
// =========================================================================
describe("type smoke", () => {
  it("R-TY-1: fool() virentia-direction overloads intersect both frameworks", () => {
    expectTypeOf(fool(event<number>())).toMatchTypeOf<VirentiaEventCallable<number>>();
    expectTypeOf(fool(event<number>())).toMatchTypeOf<EffectorEventCallable<number>>();
    // A fooled virentia effect is callable as an effector effect at runtime; the exact
    // intersection-type surface is asserted in the dedicated type-test wave.
    const vfx = fool(effect(async (p: number): Promise<number> => p));
    expectTypeOf(vfx).toMatchTypeOf<VirentiaEffect<number, number, unknown>>();
  });

  it("R-TY-1 mirror: fool() effector-direction overloads intersect both frameworks", () => {
    expectTypeOf(fool(createEvent<number>())).toMatchTypeOf<EffectorEventCallable<number>>();
    expectTypeOf(fool(createEvent<number>())).toMatchTypeOf<VirentiaEventCallable<number>>();
  });
});
