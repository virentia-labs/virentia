import { describe, expect, it } from "vitest";
import { scope } from "../lib";
import { node } from "../lib/internal";
import {
  detachScopedDependent,
  disposeScopeEdges,
  getScopedObservers,
  reconcileScopedEdges,
} from "../lib/kernel/scoped-edges";

const ids = (set: ReadonlySet<{ id?: PropertyKey }> | undefined): PropertyKey[] =>
  set ? [...set].map((node) => node.id as PropertyKey) : [];

describe("scoped-edges", () => {
  it("keeps dependency sets independent per scope", () => {
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

  it("reconciles: attaches new sources and detaches dropped ones", () => {
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

  it("does not clobber another scope's edges when one reconciles", () => {
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

  it("detaches a dependent from all its sources in a scope", () => {
    const s = scope();
    const a = node({ id: "a" });
    const b = node({ id: "b" });
    const reaction = node({ id: "r" });

    reconcileScopedEdges(s, reaction, [a, b]);
    detachScopedDependent(s, reaction);

    expect(getScopedObservers(s, a)).toBeUndefined();
    expect(getScopedObservers(s, b)).toBeUndefined();
  });

  it("disposes an entire scope's edges at once", () => {
    const s = scope();
    const a = node({ id: "a" });
    const reaction = node({ id: "r" });

    reconcileScopedEdges(s, reaction, [a]);
    disposeScopeEdges(s);

    expect(getScopedObservers(s, a)).toBeUndefined();
  });
});
