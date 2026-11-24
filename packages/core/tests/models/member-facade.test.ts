import { describe, expect, it } from "vitest";
import { computed, getOwner, onCleanup, owner, scope, scoped, store } from "../../lib";
import { collectModelFieldReads, instanceInternalOf } from "../../lib/models/definition";
import { f, staticModel } from "../../lib/models";
import { getActiveScope } from "../../lib/scope/internal";

function defineModel() {
  return staticModel({
    data: { count: f.number(0) },
    setup(self) {
      return { doubled: computed(() => self.count.value * 2), local: store(0) };
    },
  });
}

describe("model store member facades", () => {
  it("honours live computed getter overrides after a cached read and restores the caller frame", () => {
    let unit!: ReturnType<typeof computed<number>>;
    const Model = staticModel({
      data: { count: f.number(2) },
      setup(self) {
        unit = computed(() => self.count.value * 2);
        return { doubled: unit };
      },
    });
    const app = scope(),
      caller = scope();
    const row = scoped(app, () => Model.create({ id: "row" }));
    const home = instanceInternalOf(row)!.scope;
    expect(row.doubled.value).toBe(4);
    const original = Object.getPrototypeOf(unit);
    Object.setPrototypeOf(unit, {
      get value() {
        expect(this).toBe(unit);
        expect(getActiveScope()).toBe(home);
        throw new Error("custom computed read");
      },
    });
    try {
      owner(() => {
        const callerOwner = getOwner();
        scoped(caller, () => {
          expect(() => row.doubled.value).toThrow("custom computed read");
          expect(getActiveScope()).toBe(caller);
          expect(getOwner()).toBe(callerOwner);
        });
      });
    } finally {
      Object.setPrototypeOf(unit, original);
    }
    scoped(caller, () => {
      expect(row.doubled.value).toBe(4);
      expect(getActiveScope()).toBe(caller);
    });
    row.count.value = 3;
    expect(row.doubled.value).toBe(6);
  });

  it("keeps the full native store API and scoped facade identities", () => {
    const Model = defineModel();
    const app = scope();
    const [a, b] = scoped(app, () => [
      Model.create({ id: "a", count: 1 }),
      Model.create({ id: "b", count: 2 }),
    ]);
    expect(a.doubled).toBe(a.doubled);
    expect(a.doubled).not.toBe(b.doubled);
    expect(a.doubled.node).toBe(b.doubled.node);
    expect([a.doubled.value, b.doubled.value]).toEqual([2, 4]);
    expect(a.doubled.writable).toBe(false);
    expect(typeof a.doubled.map).toBe("function");
    expect(typeof a.doubled.filter).toBe("function");
    expect(Object.getPrototypeOf(a.doubled)).toBe(Object.prototype);
    expect(Reflect.get(a.doubled, "constructor")).toBe(Object);
    expect(Reflect.get(a.doubled, "__proto__")).toBe(Object.prototype);
    a.local.value = 5;
    expect([a.local.value, b.local.value]).toEqual([5, 0]);
  });

  it("forwards native reflection and customized API descriptors without a nested proxy target", () => {
    let unit!: ReturnType<typeof store<number>>;
    const Model = staticModel({
      setup() {
        unit = store(0);
        return { unit };
      },
    });
    const instance = scoped(scope(), () => Model.create({ id: "a" }));
    expect(Reflect.ownKeys(instance.unit)).toEqual(Reflect.ownKeys(unit));
    // A value store keeps `value` and its api on its prototype: nothing enumerable is own.
    expect(Object.keys(instance.unit)).toEqual([]);
    expect("value" in instance.unit).toBe(true);
    expect(Object.getOwnPropertyDescriptor(instance.unit, "value")).toEqual(
      Object.getOwnPropertyDescriptor(unit, "value"),
    );
    instance.unit.value = 3;
    expect(Object.keys({ ...instance.unit })).toEqual([]);
    expect(JSON.parse(JSON.stringify(instance.unit))).toEqual({ value: 3 });
    Object.defineProperty(instance.unit, "writable", {
      value: true,
      configurable: false,
      writable: false,
      enumerable: false,
    });
    expect(instance.unit.writable).toBe(true);
    expect(Object.getOwnPropertyDescriptor(instance.unit, "writable")).toEqual(
      Object.getOwnPropertyDescriptor(unit, "writable"),
    );
    expect(Reflect.deleteProperty(instance.unit, "writable")).toBe(false);
    expect(Object.getPrototypeOf(instance.unit)).toBe(Object.prototype);
    const prototype = {
      get value() {
        return 7;
      },
    };
    const native = Object.getPrototypeOf(unit);
    Object.setPrototypeOf(unit, prototype);
    expect(Object.getPrototypeOf(instance.unit)).toBe(prototype);
    expect(instance.unit.value).toBe(7);
    Object.setPrototypeOf(unit, native);
    expect(instance.unit.value).toBe(3);
  });

  it("preserves detached subscribe and filters changes from other model instances", () => {
    const Model = defineModel();
    const app = scope();
    const [a, b] = scoped(app, () => [
      Model.create({ id: "a", count: 1 }),
      Model.create({ id: "b", count: 2 }),
    ]);
    const seen: number[] = [];
    const { subscribe } = a.doubled;
    expect(a.doubled.subscribe).toBe(subscribe);
    const off = subscribe((value) => {
      seen.push(value);
    });
    a.count.value = 3;
    b.count.value = 5;
    expect(seen).toEqual([6]);
    off();
    a.count.value = 4;
    expect(seen).toEqual([6]);
  });

  it("keeps field-read collectors usable with frozen sources", () => {
    const Model = defineModel();
    const instance = scoped(scope(), () => Model.create({ id: "a", count: 2 }));
    const sources = new Set<{ subscribe(listener: () => void): () => void }>();
    collectModelFieldReads(
      (source) => {
        sources.add(source);
      },
      () => {
        expect(instance.doubled.value).toBe(4);
        expect(instance.doubled.value).toBe(4);
      },
    );
    expect(sources.size).toBe(1);
    const source = [...sources][0];
    Object.freeze(source);
    let updates = 0;
    const off = source.subscribe(() => {
      updates++;
    });
    instance.count.value = 3;
    expect(updates).toBe(1);
    off();
  });

  it("retains stale-handle guards for both reads and writable members", () => {
    const Model = defineModel();
    const instance = scoped(scope(), () => Model.create({ id: "a" }));
    const computed = instance.doubled,
      local = instance.local;
    instance.dispose();
    expect(() => computed.value).toThrow("entity was disposed");
    expect(() => {
      local.value = 3;
    }).toThrow("entity was disposed");
  });

  it("allocates no task owner for pure reads but preserves one owner for escaping work", () => {
    const owners: unknown[] = [],
      calls: string[] = [];
    const Model = staticModel({
      data: { count: f.number(1) },
      setup(self) {
        return {
          pure: computed(() => self.count.value * 2),
          first: computed(() => {
            owners.push(getOwner());
            onCleanup(() => {
              calls.push("first");
            });
            return 1;
          }),
          second: computed(() => {
            owners.push(getOwner());
            owner(() => {
              onCleanup(() => {
                calls.push("child");
              });
            });
            return 2;
          }),
        };
      },
    });
    const instance = scoped(scope(), () => Model.create({ id: "a" }));
    expect(instance.pure.value).toBe(2);
    expect(instanceInternalOf(instance)!.taskOwner).toBeUndefined();
    expect(instance.first.value).toBe(1);
    expect(instance.second.value).toBe(2);
    expect(owners[0]).toBe(owners[1]);
    expect(owners[0]).toBe(instanceInternalOf(instance)!.taskOwner);
    expect(getOwner()).toBeNull();
    instance.dispose();
    expect(calls).toEqual(["child", "first"]);
  });

  it("runs late cleanup immediately if a pure computed disposed its own model", () => {
    let cleaned = 0;
    const Model = staticModel({
      setup(self) {
        return {
          result: computed(() => {
            self.dispose();
            onCleanup(() => {
              cleaned++;
            });
            return "done";
          }),
        };
      },
    });
    const instance = scoped(scope(), () => Model.create({ id: "a" }));
    expect(instance.result.value).toBe("done");
    expect(instance.alive).toBe(false);
    expect(cleaned).toBe(1);
    expect(getOwner()).toBeNull();
  });
});
