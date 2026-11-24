import { expect, it } from "vitest";
import { scope, scoped } from "../../lib";
import { modelInstanceBindingOf } from "../../lib/internal";
import { f, staticModel } from "../../lib/models";
import { nativeStoreStateOf } from "../../lib/units/store";

it("keeps public instance value maps stable and isolated while reading field defaults", () => {
  const Row = staticModel({ data: { count: f.number(0) } });
  const app = scope();
  const [a, b] = scoped(app, () => [Row.create({ id: "a" }), Row.create({ id: "b" })]);
  const first = modelInstanceBindingOf(a)!.scope, second = modelInstanceBindingOf(b)!.scope;
  const firstValues = first.values, secondValues = second.values;
  expect(firstValues).not.toBe(secondValues);
  expect([a.count.value, b.count.value]).toEqual([0, 0]);
  expect(firstValues.size).toBe(0);
  expect(secondValues.size).toBe(0);
  a.count.value = 3;
  expect(first.values).toBe(firstValues);
  expect(first.values).toBeInstanceOf(Map);
  expect(second.values).toBe(secondValues);
  expect(secondValues.size).toBe(0);
  expect([a.count.value, b.count.value]).toEqual([3, 0]);
});

it("preserves the public Map surface, copies and frozen model scopes", () => {
  const Row = staticModel({ data: { count: f.number(0) } });
  const row = scoped(scope(), () => Row.create({ id: "row" }));
  const home = modelInstanceBindingOf(row)!.scope;
  Object.freeze(home);
  expect(Reflect.set(home, "values", new Map())).toBe(false);
  row.count.value = 4;
  expect(row.count.value).toBe(4);
  const values = home.values;
  expect(values).toBeInstanceOf(Map);
  expect([...values.values()]).toContain(4);
  expect(new Map(values).size).toBe(values.size);
  expect({ ...home }.values).toBe(values);
  expect(home.values).toBe(values);
});

it("honours explicit replacement value-map data and getter properties", () => {
  for (const getter of [false, true]) {
    const Row = staticModel({ data: { count: f.number(0) } });
    const row = scoped(scope(), () => Row.create({ id: "row" }));
    const home = modelInstanceBindingOf(row)!.scope;
    const key = nativeStoreStateOf(Row.fields.get("count")!.staticStore!)!.id;
    const values = new Map([[key, 9]]);
    Object.defineProperty(home, "values", getter
      ? { get: () => values, enumerable: true, configurable: true }
      : { value: values, writable: true, enumerable: true, configurable: true });
    expect(row.count.value).toBe(9);
    row.count.value = 10;
    expect(values.get(key)).toBe(10);
  }
});
