import { describe, expect, it } from "vitest";
import { reactive, scope, scoped, seedScopeStoreValue } from "../../lib";
import { withTransaction } from "../../lib/internal";
import { readStoreValue } from "../../lib/units/store";

// Read a reactive store's whole committed object inside a scope. Reactive stores
// expose fields directly (no `.value`), so the ref-mode `readValue` helper does
// not apply here.
const readObject = <T>(sc: ReturnType<typeof scope>, r: object): T =>
  scoped(sc, () => readStoreValue(r as never)) as T;

describe("reactive", () => {
  describe("a write to a key absent from the initial state", () => {
    it("exposes the new field to reads, `in`, and Object.keys", () => {
      const sc = scope();
      const r = reactive({ a: 1 } as Record<string, number>);

      scoped(sc, () => {
        r.b = 2;

        expect(r.b).toBe(2);
        expect("b" in r).toBe(true);
        expect(Object.keys(r)).toEqual(expect.arrayContaining(["a", "b"]));

        const spread = { ...(r as Record<string, unknown>) };
        expect(spread.a).toBe(1);
        expect(spread.b).toBe(2);
      });
    });

    it("notifies subscribers with the extended object", () => {
      const sc = scope();
      const r = reactive({ a: 1 } as Record<string, number>);
      const seen: unknown[] = [];
      r.subscribe((value) => seen.push(value));

      scoped(sc, () => {
        r.b = 2;
      });

      expect(seen).toEqual([{ a: 1, b: 2 }]);
      expect(readObject(sc, r)).toEqual({ a: 1, b: 2 });
    });
  });

  describe("an absent field", () => {
    it("reads as undefined and is absent from `in` until a write flips both", () => {
      const sc = scope();
      const r = reactive({ a: 1 } as Record<string, number>);

      scoped(sc, () => {
        expect(r.missing).toBeUndefined();
        expect("missing" in r).toBe(false);

        r.missing = 9;

        expect(r.missing).toBe(9);
        expect("missing" in r).toBe(true);
      });
    });
  });

  describe("two field writes inside one transaction", () => {
    it("coalesce into a single commit and one notification carrying both fields", () => {
      const sc = scope();
      const r = reactive({ a: 0, b: 0 });
      const seen: unknown[] = [];
      r.subscribe((value) => seen.push(value));

      scoped(sc, () => {
        withTransaction(() => {
          r.a = 1;
          r.b = 2;
        });
      });

      expect(seen).toEqual([{ a: 1, b: 2 }]);
      expect(readObject(sc, r)).toEqual({ a: 1, b: 2 });
    });
  });

  describe("a seeded writable reactive", () => {
    it("seeds the whole object without notifying subscribers", () => {
      const sc = scope();
      const r = reactive({ a: 0, b: 0 });
      const seen: unknown[] = [];
      r.subscribe((value) => seen.push(value));

      seedScopeStoreValue(sc, r as never, { a: 10, b: 20 });

      expect(readObject(sc, r)).toEqual({ a: 10, b: 20 });
      expect(seen).toEqual([]);
    });

    it("lets a later field write build on the seeded object", () => {
      const sc = scope();
      const r = reactive({ a: 0, b: 0 } as Record<string, number>);
      const seen: unknown[] = [];
      r.subscribe((value) => seen.push(value));

      seedScopeStoreValue(sc, r as never, { a: 10, b: 20 });

      scoped(sc, () => {
        r.c = 30;
      });

      expect(seen).toEqual([{ a: 10, b: 20, c: 30 }]);
      expect(readObject(sc, r)).toEqual({ a: 10, b: 20, c: 30 });
    });
  });
});
