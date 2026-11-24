import { describe, expect, it } from "vitest";
import { computed, getCurrentScope, getOwner, owner, reactive, scope, scoped } from "../../lib";
import type { Node } from "../../lib/internal";
import { f, model, staticModel } from "../../lib/models";
import { instanceInternalOf } from "../../lib/models/definition";

describe("shared static member reader metadata", () => {
  it("keeps instance caches and subscriptions isolated after disposal and recreation", async () => {
    const Row = staticModel({
      data: { count: f.number(1) },
      setup(self) {
        return { doubled: computed(() => self.count.value * 2) };
      },
    });
    const app = scope(),
      otherApp = scope();
    const first = scoped(app, () => Row.create({ id: "same", count: 2 }));
    const stale = first.doubled;
    expect(stale.value).toBe(4);
    const second = scoped(app, () => Row.create({ id: "other", count: 3 }));
    const foreign = scoped(otherApp, () => Row.create({ id: "same", count: 5 }));
    const seen: number[] = [];
    const off = second.doubled.subscribe((value) => seen.push(value));
    expect([second.doubled.value, foreign.doubled.value]).toEqual([6, 10]);
    first.count.value = 4;
    foreign.count.value = 6;
    expect(seen).toEqual([]);
    second.count.value = 7;
    expect(seen).toEqual([14]);
    await first.dispose();
    const reused = scoped(app, () => Row.create({ id: "same", count: 9 }));
    expect(reused.doubled === stale).toBe(false);
    expect([reused.doubled.value, second.doubled.value, foreign.doubled.value]).toEqual([
      18, 14, 12,
    ]);
    expect(() => stale.value).toThrow("disposed");
    off();
    await reused.dispose();
    await second.dispose();
    await foreign.dispose();
  });

  it("keeps API getters and scope resolvers live for facades created after the first read", async () => {
    let unit!: ReturnType<typeof computed<number>>;
    const Row = staticModel({
      data: { count: f.number(1) },
      setup(self) {
        return { doubled: (unit = computed(() => self.count.value * 2)) };
      },
    });
    const app = scope(),
      caller = scope(),
      redirected = scope();
    const first = scoped(app, () => Row.create({ id: "first", count: 2 }));
    expect(first.doubled.value).toBe(4);
    const second = scoped(app, () => Row.create({ id: "second", count: 3 }));
    const originalPrototype = Object.getPrototypeOf(unit);
    Object.setPrototypeOf(unit, {
      get value() {
        expect(this).toBe(unit);
        expect(getCurrentScope()).toBe(instanceInternalOf(second)!.scope);
        return 99;
      },
    });
    try {
      owner(() => {
        const callerOwner = getOwner();
        scoped(caller, () => {
          expect(second.doubled.value).toBe(99);
          expect(getCurrentScope()).toBe(caller);
          expect(getOwner()).toBe(callerOwner);
        });
      });
    } finally {
      Object.setPrototypeOf(unit, originalPrototype);
    }
    scoped(redirected, () => {
      Row.fields.get("count")!.staticStore!.value = 7;
    });
    const node = unit.node as Node;
    const originalResolver = node.resolveScope;
    node.resolveScope = () => redirected;
    const third = scoped(app, () => Row.create({ id: "third", count: 4 }));
    try {
      expect([third.doubled.value, second.doubled.value, first.doubled.value]).toEqual([
        14, 14, 14,
      ]);
    } finally {
      node.resolveScope = originalResolver;
    }
    expect([first.doubled.value, second.doubled.value, third.doubled.value]).toEqual([4, 6, 8]);
    await first.dispose();
    await second.dispose();
    await third.dispose();
  });

  for (const define of [model, staticModel]) {
    it(`${define.name} preserves custom store reads for each new member facade`, async () => {
      let offset = 0;
      const Row = define({
        data: { count: f.number(1) },
        setup(self) {
          const source = computed(() => self.count.value * 2);
          const custom = new Proxy(source, {
            get(target, key, receiver) {
              const value = Reflect.get(target, key, receiver);
              return key === "value" ? (value as number) + offset : value;
            },
          });
          return { doubled: custom };
        },
      });
      const app = scope(),
        caller = scope();
      const first = scoped(app, () => Row.create({ id: "first", count: 2 }));
      expect(first.doubled.value).toBe(4);
      offset = 10;
      const second = scoped(app, () => Row.create({ id: "second", count: 3 }));
      scoped(caller, () => {
        expect([second.doubled.value, first.doubled.value]).toEqual([16, 14]);
        expect(getCurrentScope()).toBe(caller);
      });
      second.count.value = 5;
      expect([second.doubled.value, first.doubled.value]).toEqual([20, 14]);
      await first.dispose();
      await second.dispose();
    });
  }

  it("preserves reactive value-property reads after sharing native metadata", async () => {
    const Row = staticModel({ setup: () => ({ state: reactive({ value: 2 }) }) });
    const app = scope();
    const first = scoped(app, () => Row.create({ id: "first" }));
    expect(first.state.value).toBe(2);
    const second = scoped(app, () => Row.create({ id: "second" }));
    expect(second.state.value).toBe(2);
    second.state.value = 5;
    expect([first.state.value, second.state.value]).toEqual([2, 5]);
    await first.dispose();
    await second.dispose();
  });
  it("does not consult unrelated Object.prototype reader properties", async () => {
    const original = Object.getOwnPropertyDescriptor(Object.prototype, "nativeReader");
    const Row = staticModel({
      data: { count: f.number(2) },
      setup(self) {
        return { doubled: computed(() => self.count.value * 2) };
      },
    });
    const app = scope();
    const first = scoped(app, () => Row.create({ id: "first" }));
    const second = scoped(app, () => Row.create({ id: "second", count: 3 }));
    Object.defineProperty(Object.prototype, "nativeReader", {
      configurable: true,
      get() {
        throw new Error("unrelated inherited getter");
      },
      set() {
        throw new Error("unrelated inherited setter");
      },
    });
    try {
      expect(first.doubled.value).toBe(4);
      expect(second.doubled.value).toBe(6);
    } finally {
      if (original) Object.defineProperty(Object.prototype, "nativeReader", original);
      else Reflect.deleteProperty(Object.prototype, "nativeReader");
      await first.dispose();
      await second.dispose();
    }
  });

});
