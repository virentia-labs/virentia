import { computed, effect, getCurrentScope, getOwner, owner, scope, scoped } from "../../lib";
import { getActiveScope, setActiveScope, type Node } from "../../lib/internal";
import { f, model, staticModel } from "../../lib/models";
import { instanceInternalOf } from "../../lib/models/definition";
import { expect, it } from "vitest";

for (const define of [model, staticModel]) {
  it(`${define.name} keeps native computed caches isolated across scopes and invalidations`, async () => {
    let calls = 0;
    const Row = define({
      data: { count: f.number(1) },
      setup(self) {
        return {
          doubled: computed(() => {
            calls++;
            return self.count.value * 2;
          }),
        };
      },
    });
    const first = scoped(scope(), () => Row.create({ id: "same" }));
    const second = scoped(scope(), () => Row.create({ id: "same", count: 2 }));
    expect(calls).toBe(0);
    const a = first.doubled,
      b = second.doubled;
    expect(calls).toBe(0);
    expect([a.value, b.value, a.value, b.value]).toEqual([2, 4, 2, 4]);
    expect(calls).toBe(2);
    first.count.value = 3;
    expect([a.value, b.value]).toEqual([6, 4]);
    expect(calls).toBe(3);
    await first.dispose();
    expect(() => a.value).toThrow("disposed");
    expect(b.value).toBe(4);
    await second.dispose();
  });
}

it("resolves native computed scope after reentrant API membership probes", async () => {
  let unit!: ReturnType<typeof computed<number>>;
  const Row = staticModel({
    data: { count: f.number(2) },
    setup(self) {
      return { doubled: (unit = computed(() => self.count.value * 2)) };
    },
  });
  const row = scoped(scope(), () => Row.create({ id: "row" }));
  const field = row.doubled,
    caller = scope(),
    other = scope();
  const source = Row.fields.get("count")!.staticStore!;
  scoped(other, () => {
    source.value = 7;
  });
  expect(field.value).toBe(4);
  const prototype = Object.getPrototypeOf(unit);
  let probes = 0;
  Object.setPrototypeOf(
    unit,
    new Proxy(prototype, {
      has(target, key) {
        if (key === "value") {
          probes++;
          setActiveScope(other);
        }
        return Reflect.has(target, key);
      },
    }),
  );
  try {
    scoped(caller, () => {
      expect(field.value).toBe(14);
      expect(getActiveScope()).toBe(caller);
    });
    expect(probes).toBe(1);
  } finally {
    Object.setPrototypeOf(unit, prototype);
  }
  expect(field.value).toBe(4);
  await row.dispose();
});

it("honours a live computed node resolver after caching its member facade", async () => {
  let unit!: ReturnType<typeof computed<number>>;
  const Row = staticModel({
    data: { count: f.number(2) },
    setup(self) {
      return { doubled: (unit = computed(() => self.count.value * 2)) };
    },
  });
  const row = scoped(scope(), () => Row.create({ id: "row" }));
  const field = row.doubled,
    other = scope(),
    node = unit.node as Node;
  scoped(other, () => {
    Row.fields.get("count")!.staticStore!.value = 5;
  });
  expect(field.value).toBe(4);
  node.resolveScope = () => other;
  try {
    expect(field.value).toBe(10);
  } finally {
    node.resolveScope = undefined;
  }
  expect(field.value).toBe(4);
  await row.dispose();
});

it("probes thenables in the caller scope and restores ownership when a probe throws", async () => {
  const caller = scope();
  let row!: { result: { readonly value: unknown } };
  const value = new Proxy(
    {},
    {
      has(_target, key) {
        if (key === "then") {
          expect(getCurrentScope()).toBe(caller);
          expect(getOwner()).toBe(instanceInternalOf(row)!.taskOwner);
          throw new Error("thenable probe");
        }
        return false;
      },
    },
  );
  const Row = staticModel({ setup: () => ({ result: computed(() => value) }) });
  const instance = scoped(scope(), () => Row.create({ id: "row" }));
  row = instance;
  owner(() => {
    const callerOwner = getOwner();
    scoped(caller, () => {
      expect(() => instance.result.value).toThrow("thenable probe");
      expect(getCurrentScope()).toBe(caller);
      expect(getOwner()).toBe(callerOwner);
    });
  });
  await instance.dispose();
});

it("preserves independent direct-await scopes and model ownership for async computed values", async () => {
  const wait = effect(async () => {});
  const Row = staticModel({
    data: { count: f.number(1) },
    setup(self) {
      return {
        result: computed(async () => {
          const value = self.count.value;
          const home = getCurrentScope();
          await wait();
          expect(getCurrentScope()).toBe(home);
          return value * 2;
        }),
      };
    },
  });
  const first = scoped(scope(), () => Row.create({ id: "same" }));
  const second = scoped(scope(), () => Row.create({ id: "same", count: 3 }));
  const left = scope(),
    right = scope();
  const values = await Promise.all([
    scoped(left, async () => {
      const value = await first.result.value;
      expect(getCurrentScope()).toBe(left);
      expect(getOwner()).toBe(instanceInternalOf(first)!.taskOwner);
      return value;
    }),
    scoped(right, async () => {
      const value = await second.result.value;
      expect(getCurrentScope()).toBe(right);
      expect(getOwner()).toBe(instanceInternalOf(second)!.taskOwner);
      return value;
    }),
  ]);
  expect(values).toEqual([2, 6]);
  await first.dispose();
  await second.dispose();
});
