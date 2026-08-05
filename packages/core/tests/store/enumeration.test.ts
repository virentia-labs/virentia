import { describe, expect, it } from "vitest";
import { reactive, readonlyReactive, scope, scoped, store } from "../../lib";

// Enumerating a store must show the STATE and nothing else. Leaking `node`,
// `subscribe`, `map`, … into `Object.keys` / spread / `JSON.stringify` corrupts
// any serialized snapshot with the store's inspector metadata — an SSR payload
// or a localStorage write that then fails to hydrate back.
describe("store enumeration", () => {
  const apiMembers = ["node", "writable", "subscribe", "map", "filter", "filterMap"];

  describe("a reactive object", () => {
    it("enumerates only its own fields", () => {
      const s = scope();
      const state = reactive({ name: "ann", age: 30 });

      scoped(s, () => {
        expect(Object.keys(state)).toEqual(["name", "age"]);
      });
    });

    it("spreads only its own fields", () => {
      const s = scope();
      const state = reactive({ name: "ann", age: 30 });

      scoped(s, () => {
        expect({ ...state }).toEqual({ name: "ann", age: 30 });
      });
    });

    it("serializes to its state alone", () => {
      const s = scope();
      const state = reactive({ name: "ann", age: 30 });

      scoped(s, () => {
        expect(JSON.parse(JSON.stringify(state))).toEqual({ name: "ann", age: 30 });
      });
    });

    it("keeps api members out of for...in and Object.entries", () => {
      const s = scope();
      const state = reactive({ a: 1 });

      scoped(s, () => {
        const seen: string[] = [];

        for (const key in state) seen.push(key);

        expect(seen).toEqual(["a"]);
        expect(Object.entries(state)).toEqual([["a", 1]]);
      });
    });

    it("picks up a field added later", () => {
      const s = scope();
      const state = reactive({ a: 1 } as Record<string, number>);

      scoped(s, () => {
        state.b = 2;
      });

      expect(scoped(s, () => Object.keys(state))).toEqual(["a", "b"]);
    });

    it("enumerates per scope", () => {
      const a = scope();
      const b = scope();
      const state = reactive({ n: 0 } as Record<string, number>);

      scoped(a, () => {
        state.extra = 1;
      });

      expect(scoped(a, () => Object.keys(state))).toEqual(["n", "extra"]);
      expect(scoped(b, () => Object.keys(state))).toEqual(["n"]);
    });

    it("hides api members from a readonlyReactive too", () => {
      const s = scope();
      const state = readonlyReactive({ a: 1 });

      scoped(s, () => {
        expect(Object.keys(state)).toEqual(["a"]);
      });
    });
  });

  describe("a plain store", () => {
    it("enumerates value alone", () => {
      const s = scope();
      const $n = store(5);

      scoped(s, () => {
        expect(Object.keys($n)).toEqual(["value"]);
        expect(JSON.parse(JSON.stringify($n))).toEqual({ value: 5 });
      });
    });
  });

  describe("the api stays reachable", () => {
    it("still resolves its members by direct access", () => {
      const s = scope();
      const state = reactive({ a: 1 });

      scoped(s, () => {
        expect(typeof state.map).toBe("function");
        expect(typeof state.subscribe).toBe("function");
        expect(state.writable).toBe(true);
        expect(state.node).toBeDefined();
      });
    });

    it("still answers the `in` operator for api members", () => {
      const s = scope();
      const state = reactive({ a: 1 });

      scoped(s, () => {
        for (const member of apiMembers) {
          expect(member in state).toBe(true);
        }

        expect("a" in state).toBe(true);
        expect("missing" in state).toBe(false);
      });
    });

    it("still derives through map", () => {
      const s = scope();
      const $n = store(2);
      const $doubled = $n.map((v) => v * 2);

      expect(scoped(s, () => $doubled.value)).toBe(4);
    });
  });
});
