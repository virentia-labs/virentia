import { describe, expect, it } from "vitest";
import { onCleanup, owner, withOwner } from "../../lib";
import type { Owner } from "../../lib";

// The Symbol.dispose the source resolves to (native where available, otherwise a
// polyfilled `Symbol.for("Symbol.dispose")`).
const disposeSymbol: symbol =
  typeof Symbol.dispose === "symbol" ? Symbol.dispose : Symbol.for("Symbol.dispose");

describe("owner dispose corner cases", () => {
  describe("onCleanup registered into an already-disposed owner whose fn throws", () => {
    // PIN CURRENT BEHAVIOR: `owner.onCleanup(fn)` runs `fn()` immediately when the
    // owner is already disposed (there is nothing left to defer to). If that `fn`
    // throws, the error is NOT swallowed — it propagates straight out to whoever
    // called `onCleanup`. There is no clear contract for this edge, so this test
    // documents the observed behavior rather than asserting an ideal one.
    it("propagates the throw to the onCleanup caller", () => {
      const m = owner((_d, o) => ({ o }));
      m.o.dispose();
      expect(m.o.disposed).toBe(true);

      expect(() =>
        withOwner(m.o, () => {
          onCleanup(() => {
            throw new Error("late-cleanup-boom");
          });
        }),
      ).toThrow("late-cleanup-boom");
    });

    it("still runs a non-throwing late cleanup immediately and returns a working noop unregister", () => {
      const calls: string[] = [];
      const m = owner((_d, o) => ({ o }));
      m.o.dispose();

      let off!: () => void;
      withOwner(m.o, () => {
        off = onCleanup(() => calls.push("ran"));
      });

      // The cleanup ran synchronously at registration time.
      expect(calls).toEqual(["ran"]);
      // Unregistering after the fact is a harmless noop.
      expect(() => off()).not.toThrow();
    });
  });

  describe("an owner result that carries its OWN dispose", () => {
    // PIN CURRENT BEHAVIOR: `attachDisposableOwner` skips a key that already
    // exists on the returned object. So an object with its own `dispose` keeps
    // that own `dispose` untouched, while `Symbol.dispose` (which the object does
    // NOT have) still gets the owner's disposer attached. The upshot is that
    // `obj.dispose()` and `obj[Symbol.dispose]()` do DIFFERENT things — a footgun
    // worth documenting, not a designed contract.
    const makeWithOwnDispose = () => {
      const calls: string[] = [];
      const own = (): void => {
        calls.push("own");
      };
      const m = owner((_d, o) => {
        onCleanup(() => calls.push("owner-cleanup"));
        return { dispose: own, o };
      });
      return { m, own, calls };
    };

    it("keeps the object's own dispose and does NOT attach the owner's to `dispose`", () => {
      const { m, own } = makeWithOwnDispose();

      // The own `dispose` was preserved verbatim.
      expect(m.dispose).toBe(own);
      // Symbol.dispose was absent on the object, so the owner's disposer landed there.
      expect(typeof (m as unknown as Record<symbol, unknown>)[disposeSymbol]).toBe("function");
    });

    it("obj.dispose() runs only the object's own dispose, leaving the owner alive", () => {
      const { m, calls } = makeWithOwnDispose();

      m.dispose();

      // Only the own dispose ran; the owner's registered cleanups did NOT.
      expect(calls).toEqual(["own"]);
      expect((m.o as Owner).disposed).toBe(false);
    });

    it("obj[Symbol.dispose]() runs the owner's cleanups instead of the own dispose", () => {
      const { m, calls } = makeWithOwnDispose();

      (m as unknown as Record<symbol, () => void>)[disposeSymbol]();

      // Symbol.dispose routes to the owner: its cleanups run, the object's own
      // `dispose` is never invoked, and the owner flips to disposed.
      expect(calls).toEqual(["owner-cleanup"]);
      expect((m.o as Owner).disposed).toBe(true);
    });
  });
});
