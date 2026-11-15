import { computed, scope, scoped } from "../../lib";
import { f, staticModel } from "../../lib/models";
import { expect, it } from "vitest";

it("keeps static self virtual while reading native fields and later setup members", () => {
  let self!: object;
  const Row = staticModel({
    data: { count: f.number(0) },
    setup(current) {
      self = current;
      expect(Reflect.ownKeys(current)).toEqual([]);
      expect(Object.getPrototypeOf(current)).toBeNull();
      expect("count" in current).toBe(false);
      expect(Object.getOwnPropertyDescriptor(current, "count")).toBeUndefined();
      return { doubled: computed(() => current.count.value * 2) };
    },
  });
  const app = scope();
  const a = scoped(app, () => Row.create({ id: "a", count: 2 }));
  const b = scoped(app, () => Row.create({ id: "b", count: 3 }));
  expect([a.doubled.value, b.doubled.value]).toEqual([4, 6]);
  expect(Reflect.ownKeys(self)).toEqual([]);
  expect(Object.getPrototypeOf(self)).toBeNull();
  expect("doubled" in self).toBe(false);
  expect(Reflect.get(self, "doubled")).toBeDefined();
});

for (const mutation of [
  "assign",
  "define",
  "delete",
  "prototype",
  "preventExtensions",
  "freeze",
] as const) {
  it(`preserves virtual static self after ${mutation}`, () => {
    let self!: object;
    const Row = staticModel({
      data: { count: f.number(0) },
      setup(current) {
        self = current;
        return { doubled: computed(() => current.count.value * 2) };
      },
    });
    const app = scope();
    const a = scoped(app, () => Row.create({ id: "a", count: 2 }));
    const b = scoped(app, () => Row.create({ id: "b", count: 3 }));
    if (mutation === "assign") Reflect.set(self, "count", "ignored");
    if (mutation === "define")
      Object.defineProperty(self, "count", { value: "ignored", configurable: true });
    if (mutation === "delete") Reflect.deleteProperty(self, "count");
    if (mutation === "prototype") Object.setPrototypeOf(self, { count: "ignored" });
    if (mutation === "preventExtensions") Object.preventExtensions(self);
    if (mutation === "freeze") Object.freeze(self);
    expect([a.doubled.value, b.doubled.value]).toEqual([4, 6]);
    a.count.value = 7;
    expect(a.doubled.value).toBe(14);
    expect(b.doubled.value).toBe(6);
    if (mutation === "assign" || mutation === "define") {
      expect(Reflect.ownKeys(self)).toEqual(["count"]);
      expect(Object.getOwnPropertyDescriptor(self, "count")!.value).toBe("ignored");
    } else expect(Reflect.ownKeys(self)).toEqual([]);
    if (mutation !== "prototype") expect(Object.getPrototypeOf(self)).toBeNull();
  });
}
