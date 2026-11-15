import { expect, it } from "vitest";
import { scope, scoped } from "../../lib";
import { modelViewCaptureOf, modelViewSnapshotOf } from "../../lib/internal";
import { children, f, inverse, model, staticModel } from "../../lib/models";

for (const define of [model, staticModel]) {
  it(`${define.name} keeps metadata current through reflection, rebinding and custom getters`, async () => {
    const Row = define({ data: { count: f.number(0) } });
    const row = scoped(scope(), () => Row.create({ id: "a" }));
    const key = row.key;
    const id = Object.getOwnPropertyDescriptor(row, "id")!.get!;
    expect(id()).toBe("a");
    row.rebind("b");
    expect([row.id, id(), row.key, row.alive]).toEqual(["b", "b", key, true]);
    Object.defineProperties(row, {
      id: { configurable: true, get() { expect(this).toBe(row); return "custom"; } },
      key: { configurable: true, get() { expect(this).toBe(row); return "custom-key"; } },
      alive: { configurable: true, get() { expect(this).toBe(row); return false; } },
    });
    expect([row.id, row.key, row.alive]).toEqual(["custom", "custom-key", false]);
    row.count.value = 2;
    expect(row.count.value).toBe(2);
    await row.dispose();
  });

  it(`${define.name} preserves native snapshot eligibility after rebind and detached json`, async () => {
    const Row = define({ data: { count: f.number(0) } });
    const row = scoped(scope(), () => Row.create({ id: "a" }));
    row.rebind("b");
    expect(modelViewSnapshotOf(row)).toEqual({ id: "b", count: 0 });
    // A detached `json` is cached on the instance, and is still the native one.
    const { json } = row;
    expect(modelViewSnapshotOf(row)).toEqual({ id: "b", count: 0 });
    expect(json()).toEqual({ id: "b", count: 0 });
    expect(row.json).toBe(json);
    Object.setPrototypeOf(row, { json() { expect(this).toBe(row); return { custom: true }; } });
    Reflect.deleteProperty(row, "json");
    expect(modelViewSnapshotOf(row)).toBeUndefined();
    expect(row.json()).toEqual({ custom: true });
    await row.dispose();
  });
}

it("a parent's json leaves its children eligible for native snapshots", async () => {
  const Child = staticModel({
    data: { label: f.string(""), parent: inverse(() => Parent.rows) },
  });
  const Parent = staticModel({ data: { rows: children.many(Child) } });
  const app = scope();
  const parent = scoped(app, () =>
    Parent.create({
      id: "p",
      rows: [
        { id: "a", label: "A" },
        { id: "b", label: "B" },
      ],
    }),
  );
  expect(parent.json()).toEqual({
    id: "p",
    rows: [
      { id: "a", label: "A" },
      { id: "b", label: "B" },
    ],
  });
  const rows = scoped(app, () => parent.rows.items);
  expect(rows).toHaveLength(2);
  for (const row of rows) {
    expect(modelViewCaptureOf(row)?.read()).toEqual(row.json());
    expect(modelViewSnapshotOf(row)).toEqual(row.json());
  }
  await scoped(app, () => parent.dispose());
});
