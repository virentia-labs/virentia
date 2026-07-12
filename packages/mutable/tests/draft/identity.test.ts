import { describe, expect, it } from "vitest";
import { scope, scoped } from "@virentia/core";
import { mutableStore, unwrap } from "../../lib";

describe("mutableStore", () => {
  describe("draft identity", () => {
    it("recreates proxies per commit while keeping owned underlying identity stable", () => {
      const state = mutableStore({ list: [] as number[] });
      const s = scope();
      scoped(s, () => state.value.list.push(1)); // diverge → owned
      const p1 = scoped(s, () => state.value.list);
      // A committing mutation tears down the draft; the next read builds a new proxy.
      // (Two consecutive *pure-read* scopes would reuse the same live draft/proxy —
      // it's the commit boundary, not the scoped() call, that recreates proxies.)
      scoped(s, () => state.value.list.push(2));
      const p2 = scoped(s, () => state.value.list);
      expect(p1).not.toBe(p2); // recreated after the commit
      expect(unwrap(p1)).toBe(unwrap(p2)); // owned → stable underlying identity
    });

    it("returns the same proxy for the same path within one transaction", () => {
      const state = mutableStore({ a: { x: 1 } });
      const s = scope();
      scoped(s, () => {
        const a1 = state.value.a;
        const a2 = state.value.a;
        expect(a1).toBe(a2); // childState cache hit while base unchanged
      });
    });

    it("invalidates a child proxy after its base changes", () => {
      const state = mutableStore({ a: { x: 1 } as { x: number } });
      const s = scope();
      scoped(s, () => {
        const a1 = state.value.a;
        state.value.a = { x: 9 };
        const a2 = state.value.a;
        expect(a1).not.toBe(a2);
        expect(unwrap(a2).x).toBe(9);
      });
    });

    it("opens a fresh draft after commit, carrying the value over", () => {
      const state = mutableStore({ a: 0 });
      const s = scope();
      scoped(s, () => {
        state.value.a = 1;
      });
      const p1 = scoped(s, () => state.value);
      scoped(s, () => {
        state.value.a = 2;
      });
      const p2 = scoped(s, () => state.value);
      expect(p1).not.toBe(p2); // draft recreated per transaction
      expect(scoped(s, () => state.value.a)).toBe(2);
    });

    it("yields different proxies for the same path in different scopes", () => {
      const state = mutableStore({ a: { x: 1 } });
      const x = scope();
      const y = scope();
      const px = scoped(x, () => state.value.a);
      const py = scoped(y, () => state.value.a);
      expect(px).not.toBe(py); // per-scope drafts
      // Both share the untouched base underneath.
      expect(unwrap(px)).toBe(unwrap(py));
    });
  });

  describe("a stale child proxy", () => {
    // Holding a child proxy across an index-shifting mutator and then writing
    // through the STALE proxy. The docs say mutators clear the child cache (i.e.
    // you should re-read). This probe documents the ACTUAL current behavior: the
    // stale proxy still threads its copy up under its OLD key, writing to whatever
    // now occupies that slot. Asserted as current behavior to pin it precisely.
    it("targets the old index slot when written after an unshift", () => {
      const state = mutableStore({
        items: [{ tag: "E" }, { tag: "F" }] as { tag: string; extra?: number }[],
      });
      const s = scope();
      scoped(s, () => {
        const stale = state.value.items[0]; // proxy for element E at index 0
        state.value.items.unshift({ tag: "X" }); // now [X, E, F]; E moved to index 1
        // Writing through the stale proxy uses its cached key "0" and threads a
        // shallow COPY of E up into itemsState.copy["0"] — which is now X's slot.
        stale.extra = 99;
        const snapshot = state.value.items.map((el) => ({ ...el }));
        // OBSERVED corruption: X is silently gone; index 0 became a copy of E with
        // the write applied, and the real E (index 1) never received the write.
        // This is the aliasing hazard of retaining a child proxy across a
        // structural mutator (the design clears the cache and expects a re-read);
        // pinned as a probe, not reported as a bug.
        expect(snapshot[0]).toEqual({ tag: "E", extra: 99 }); // copy of E overwrote X
        expect(snapshot[1]).toEqual({ tag: "E" }); // real E untouched by the write
        expect(snapshot[2]).toEqual({ tag: "F" });
        expect(snapshot.some((el) => el.tag === "X")).toBe(false); // X vanished
      });
    });
  });
});
