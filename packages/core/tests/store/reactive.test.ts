import { describe, expect, it } from "vitest";
import { reactive, readonlyReactive, scope, scoped } from "../../lib";
import { readStoreValue } from "../../lib/units/store";

describe("reactive", () => {
  it("reads and writes fields without .value", () => {
    const sc = scope();
    const u = reactive({ name: "Ada", age: 36 });

    scoped(sc, () => {
      u.age = 37;
      expect(u.name).toBe("Ada");
      expect(u.age).toBe(37);
    });
  });

  it("writes an immutable copy, leaving the prior snapshot intact", () => {
    const sc = scope();
    const u = reactive({ name: "Ada", age: 36 });

    scoped(sc, () => {
      const before = readStoreValue(u as never) as { name: string; age: number };
      u.age = 37;
      const after = readStoreValue(u as never) as { name: string; age: number };

      expect(before).toEqual({ name: "Ada", age: 36 });
      expect(after).toEqual({ name: "Ada", age: 37 });
      expect(after).not.toBe(before);
    });
  });

  it("preserves array-ness with a fresh array on a field write", () => {
    const sc = scope();
    const a = reactive([1, 2, 3]);

    scoped(sc, () => {
      const before = readStoreValue(a as never) as number[];
      a[1] = 9;
      const after = readStoreValue(a as never) as number[];

      expect(Array.isArray(after)).toBe(true);
      expect(after).toEqual([1, 9, 3]);
      expect(before).toEqual([1, 2, 3]);
      expect(after).not.toBe(before);
    });
  });

  it("notifies on a same-value field write", () => {
    const sc = scope();
    const u = reactive({ age: 37 });
    const seen: unknown[] = [];
    u.subscribe((value) => seen.push(value));

    scoped(sc, () => {
      u.age = 37;
      u.age = 37;
    });

    expect(seen).toEqual([{ age: 37 }, { age: 37 }]);
  });

  it("never suppresses a write for a skip token", () => {
    const sc = scope();
    const u = reactive({ n: 0 }, { n: 0 });
    const seen: unknown[] = [];
    u.subscribe((value) => seen.push(value));

    scoped(sc, () => {
      u.n = 0;
    });

    // The freshly-built object is never Object.is the token, so skip is dead.
    expect(seen).toEqual([{ n: 0 }]);
  });

  it("throws when a readonly field is assigned", () => {
    const sc = scope();
    const r = readonlyReactive({ a: 1 });

    expect(() =>
      scoped(sc, () => {
        (r as unknown as { a: number }).a = 2;
      }),
    ).toThrow("Store is read-only");
  });

  describe("field access", () => {
    it("exposes state fields to spread, keys, and in", () => {
      const sc = scope();
      const r = reactive({ name: "Ada", age: 36 });

      scoped(sc, () => {
        const spread = { ...r } as Record<string, unknown>;
        expect(spread.name).toBe("Ada");
        expect(spread.age).toBe(36);
        expect(Object.keys(r)).toEqual(expect.arrayContaining(["name", "age"]));
        expect("age" in r).toBe(true);
        expect("name" in r).toBe(true);
      });
    });

    it("treats an absent field as undefined", () => {
      const sc = scope();
      const r = reactive({ a: 1 });

      scoped(sc, () => {
        expect((r as unknown as Record<string, unknown>).missing).toBeUndefined();
        expect("missing" in r).toBe(false);
      });
    });
  });

  it("shadows same-named state fields with StoreApi members", () => {
    const sc = scope();
    const r = reactive({ node: 123, subscribe: "x" } as Record<string, unknown>);

    scoped(sc, () => {
      expect(typeof (r as { subscribe: unknown }).subscribe).toBe("function");
      expect((r as { node: unknown }).node).not.toBe(123);
      expect((r as { node: unknown }).node).toBe((r as { node: unknown }).node);
      // Writing an API member is rejected by the set trap (property in target).
      expect(() => {
        (r as unknown as { node: number }).node = 5;
      }).toThrow();
    });
  });

  it("exposes a configurable, enumerable descriptor for a state key", () => {
    const sc = scope();
    const r = reactive({ x: 5 });

    scoped(sc, () => {
      const descriptor = Object.getOwnPropertyDescriptor(r, "x");
      expect(descriptor).toBeDefined();
      expect(descriptor?.configurable).toBe(true);
      expect(descriptor?.enumerable).toBe(true);
      expect((r as { x: number }).x).toBe(5);
    });
  });
});
