import { afterEach, describe, expect, it } from "vitest";
import { getCurrentScope, scope, scoped, store } from "../../lib";
import { resetActiveScope } from "../support/scope-helpers";

afterEach(resetActiveScope);

describe("nested scoped() of the same scope", () => {
  it("runs inner and outer in the same scope and restores to the pre-outer null", () => {
    const s = scope();
    const st = store(0);

    expect(getCurrentScope()).toBe(null);

    scoped(s, () => {
      expect(getCurrentScope()).toBe(s);

      scoped(s, () => {
        // Re-entering the SAME scope keeps it ambient.
        expect(getCurrentScope()).toBe(s);
        st.value = 5;
      });

      // Restored to the outer frame, which is still s.
      expect(getCurrentScope()).toBe(s);
      // The inner write is visible in the outer frame (same scope).
      expect(st.value).toBe(5);
    });

    // Restored all the way back to the pre-outer ambient (null).
    expect(getCurrentScope()).toBe(null);
    expect(scoped(s, () => st.value)).toBe(5);
  });

  it("restores to a non-null pre-outer scope after nesting the same scope", () => {
    const outerAmbient = scope();
    const s = scope();
    const st = store(0);

    scoped(outerAmbient, () => {
      expect(getCurrentScope()).toBe(outerAmbient);

      scoped(s, () => {
        scoped(s, () => {
          st.value = 7;
        });
        // Inner scoped(s) restored to the enclosing scoped(s), still s.
        expect(getCurrentScope()).toBe(s);
      });

      // scoped(s) restored to the pre-outer ambient — the enclosing scope.
      expect(getCurrentScope()).toBe(outerAmbient);
    });

    expect(getCurrentScope()).toBe(null);
    expect(scoped(s, () => st.value)).toBe(7);
    // The write landed in s, not in the enclosing ambient scope.
    expect(scoped(outerAmbient, () => st.value)).toBe(0);
  });

  it("keeps deeply nested same-scope frames all pointed at the one scope", () => {
    const s = scope();
    const seen: Array<ReturnType<typeof getCurrentScope>> = [];

    scoped(s, () => {
      seen.push(getCurrentScope());
      scoped(s, () => {
        seen.push(getCurrentScope());
        scoped(s, () => {
          seen.push(getCurrentScope());
        });
        seen.push(getCurrentScope());
      });
      seen.push(getCurrentScope());
    });

    expect(seen).toEqual([s, s, s, s, s]);
    expect(getCurrentScope()).toBe(null);
  });
});

describe("a synchronously throwing scoped() body", () => {
  it("restores the ambient to the enclosing scope and rethrows", () => {
    const outer = scope();
    const inner = scope();

    scoped(outer, () => {
      expect(getCurrentScope()).toBe(outer);

      expect(() =>
        scoped(inner, () => {
          expect(getCurrentScope()).toBe(inner);
          throw new Error("boom");
        }),
      ).toThrow("boom");

      // The throw restored the ambient to the enclosing scope, not to null and
      // not left stuck at inner.
      expect(getCurrentScope()).toBe(outer);
    });

    expect(getCurrentScope()).toBe(null);
  });

  it("restores the ambient to the same enclosing scope when the nested scope is identical", () => {
    const s = scope();

    scoped(s, () => {
      expect(() =>
        scoped(s, () => {
          throw new Error("same-scope boom");
        }),
      ).toThrow("same-scope boom");

      // A throw from a nested same-scope frame restores to the enclosing s.
      expect(getCurrentScope()).toBe(s);
    });

    expect(getCurrentScope()).toBe(null);
  });

  it("does not leak a partial write from a throwing frame's later statements", () => {
    const s = scope();
    const st = store(0);

    scoped(s, () => {
      expect(() =>
        scoped(s, () => {
          st.value = 3; // this write commits (auto-transaction closes on the set)
          throw new Error("after-write boom");
        }),
      ).toThrow("after-write boom");

      // The pre-throw write is applied; the ambient is restored to s.
      expect(st.value).toBe(3);
      expect(getCurrentScope()).toBe(s);
    });
  });
});
