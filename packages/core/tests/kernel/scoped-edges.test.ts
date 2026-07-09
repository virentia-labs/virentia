import { afterEach, describe, expect, it } from "vitest";
import { scope } from "../../lib";
import { node, run, setActiveScope } from "../../lib/internal";
import {
  detachScopedDependent,
  disposeScopeEdges,
  getScopedObservers,
  reconcileScopedEdges,
} from "../../lib/kernel/scoped-edges";
import { ids } from "../support/kernel-node";

describe("scoped edges", () => {
  // Reset the ambient scope after every test so a manual setActiveScope() or an
  // async tail's neutral reset never leaks into the next test.
  const reset = (): void => void setActiveScope(null);

  afterEach(reset);

  describe("dependency sets", () => {
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
