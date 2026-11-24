import { expect, it } from "vitest";
import { scope, scoped } from "../../lib";
import { fixedStoreNodeOf, modelInstanceBindingOf, node } from "../../lib/internal";
import { f, model, staticModel } from "../../lib/models";

for (const define of [model, staticModel]) {
  it(`${define.name} keeps cached fields isolated across scopes, rebinds and recycled IDs`, async () => {
    const Row = define({ data: { count: f.number(0) } });
    const left = scope(),
      right = scope();
    const a = scoped(left, () => Row.create({ id: "same" }));
    const b = scoped(right, () => Row.create({ id: "same" }));
    const first = a.count,
      second = b.count;
    first.value = 1;
    second.value = 2;
    a.rebind("renamed");
    expect(a.count).toBe(first);
    expect([first.value, second.value]).toEqual([1, 2]);
    await a.dispose();
    await Promise.resolve();
    const replacement = scoped(left, () => Row.create({ id: "same" }));
    replacement.count.value = 3;
    expect([replacement.count.value, second.value]).toEqual([3, 2]);
    expect(() => first.value).toThrow();
    expect(() => {
      first.value = 4;
    }).toThrow();
    expect(b.count).toBe(second);
    await replacement.dispose();
    await b.dispose();
  });
}

it("does not reuse a stale shared field node after live declaration customization", async () => {
  const Row = staticModel({ data: { count: f.number(0) } });
  const app = scope();
  const first = scoped(app, () => Row.create({ id: "first" }));
  const field = first.count;
  const unit = Row.fields.get("count")!.staticStore!;
  const original = unit.node,
    customized = node();
  try {
    // `node` is inherited: an own property customizes it, deleting it restores.
    Object.defineProperty(unit, "node", { configurable: true, value: customized });
    const second = scoped(app, () => Row.create({ id: "second" }));
    expect(field.node).toBe(original);
    expect(second.count.node).toBe(customized);
    expect(fixedStoreNodeOf(second.count, modelInstanceBindingOf(second)!.scope)).toBeUndefined();
    second.count.value = 7;
    expect([field.value, second.count.value]).toEqual([0, 7]);
    await second.dispose();
  } finally {
    delete (unit as { node?: unknown }).node;
    await first.dispose();
  }
});
