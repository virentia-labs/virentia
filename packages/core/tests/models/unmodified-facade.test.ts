import { computed, scope, scoped } from "../../lib";
import { f, staticModel } from "../../lib/models";
import { expect, it } from "vitest";

it("retains cached units across own-property overrides and deletion", () => {
  const Row = staticModel({ data: { count: f.number(0) } });
  const row = scoped(scope(), () => Row.create({ id: "row" }));
  const count = row.count;
  expect(row.count).toBe(count);
  Object.defineProperty(row, "count", { configurable: true, get: () => "override" });
  expect(Reflect.get(row, "count")).toBe("override");
  Reflect.deleteProperty(row, "count");
  expect(row.count).toBe(count);
  row.dispose();
});

it("retains Object.prototype precedence over an already cached field", () => {
  const name = "__virentiaNativeFacadeTestField";
  const Row = staticModel({ data: { [name]: f.number(0) } });
  const row = scoped(scope(), () => Row.create({ id: "row" }));
  const field = row[name];
  try {
    Object.defineProperty(Object.prototype, name, { value: "shadow", configurable: true });
    expect(Reflect.get(row, name)).toBe("shadow");
  } finally {
    Reflect.deleteProperty(Object.prototype, name);
  }
  expect(row[name]).toBe(field);
  row.dispose();
});

it("keeps alive reactive and identity readable after rebinding and disposal", () => {
  const Row = staticModel({ data: { count: f.number(0) } });
  const app = scope();
  const row = scoped(app, () => Row.create({ id: "before" }));
  const alive = computed(() => row.alive);
  const key = row.key;
  expect(scoped(app, () => alive.value)).toBe(true);
  row.rebind("after");
  expect(row.id).toBe("after");
  expect(row.key).toBe(key);
  row.dispose();
  expect(scoped(app, () => alive.value)).toBe(false);
  expect(row.id).toBe("after");
  expect(row.key).toBe(key);
});

it("retains customized identity accessors and detached json after reflective access", () => {
  const Row = staticModel({ data: { count: f.number(0) } });
  const row = scoped(scope(), () => Row.create({ id: "row" }));
  const json = row.json;
  row.count.value = 3;
  expect(json()).toEqual({ id: "row", count: 3 });
  Object.defineProperty(row, "id", { configurable: true, get: () => "display" });
  expect(row.id).toBe("display");
  expect(json()).toEqual({ id: "row", count: 3 });
  row.dispose();
});
