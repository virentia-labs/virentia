import { describe, expect, it } from "vitest";
import { reactive, readonlyReactive, scope, scoped } from "../../lib";

describe("reactive", () => {
  describe("deleting a field", () => {
    it("removes the key and reads back undefined", () => {
      const r = reactive({ a: 1 as number | undefined, b: 2 });
      const sc = scope();
      scoped(sc, () => {
        delete (r as { a?: number }).a;
        expect(r.a).toBeUndefined();
        expect("a" in r).toBe(false);
        expect(r.b).toBe(2);
      });
    });

    it("notifies subscribers with the object minus the key", () => {
      const r = reactive({ a: 1 as number | undefined, b: 2 });
      const seen: unknown[] = [];
      r.subscribe((v) => seen.push(v));
      const sc = scope();
      scoped(sc, () => {
        delete (r as { a?: number }).a;
      });
      expect(seen).toEqual([{ b: 2 }]);
    });

    it("is a no-op success for an absent key", () => {
      const r = reactive({ a: 1 });
      const seen: unknown[] = [];
      r.subscribe((v) => seen.push(v));
      const sc = scope();
      let result: boolean | undefined;
      scoped(sc, () => {
        result = delete (r as { nope?: number }).nope;
      });
      expect(result).toBe(true);
      expect(seen).toEqual([]);
    });

    it("throws when deleting a field of a readonly reactive", () => {
      const r = readonlyReactive({ a: 1 });
      const sc = scope();
      expect(() =>
        scoped(sc, () => {
          delete (r as { a?: number }).a;
        }),
      ).toThrow("Store is read-only");
    });
  });
});
