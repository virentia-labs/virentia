import { expect, it, vi } from "vitest";
import { scope, scoped, serialize } from "../../lib";
import { modelDefaultCreator, modelDefinitionBindingOf } from "../../lib/internal";
import { f, staticModel } from "../../lib/models";

it("keeps identity-only creation on the same registry and initialization path", () => {
  const created = vi.fn();
  const Row = staticModel({
    data: { count: f.number(0) },
    onCreate(self) {
      self.count.value = 3;
      created();
    },
  });
  const app = scope();
  const rows = modelDefinitionBindingOf(Row)!.collection(app);
  const row = rows[modelDefaultCreator]!("row");
  expect(row).toBe(scoped(app, () => Row.get("row")));
  expect(scoped(app, () => Row.get("row")!.count.value)).toBe(3);
  expect(rows[modelDefaultCreator]!("row")).toBe(row);
  expect(created).toHaveBeenCalledTimes(1);
});

it("declines required fields, indexed fields and ID-bound inputs without mutating the registry", () => {
  const Required = staticModel({ data: { count: f.number() } });
  const Indexed = staticModel({ data: { count: f.number(0).indexed() } });
  const IdBound = staticModel({
    data: (props: import("../../lib/models").Props<{ id?: string }>) => ({
      label: f.string(props.id.or("fallback")),
    }),
  });
  for (const Model of [Required, Indexed, IdBound]) {
    const rows = modelDefinitionBindingOf(Model)!.collection(scope());
    expect(rows[modelDefaultCreator]!("row")).toBeUndefined();
    expect(rows.count).toBe(0);
  }
});

it("restores fields before onCreate even through the default constructor", () => {
  const seen: number[] = [];
  const Row = staticModel({
    name: "DefaultCreationSnapshot",
    data: { count: f.number(0) },
    onCreate(self) {
      seen.push(self.count.value);
    },
  });
  const server = scope();
  scoped(server, () => Row.create({ id: "row", count: 7 }));
  const snapshot = serialize(server);
  const client = scope({ snapshot });
  const rows = modelDefinitionBindingOf(Row)!.collection(client);
  expect(rows[modelDefaultCreator]!("row")).toBe(scoped(client, () => Row.get("row")));
  expect(seen).toEqual([7, 7]);
  expect(serialize(client)).toEqual(snapshot);
});

it("falls back if a default no longer matches the native declaration initial", () => {
  const count = f.number(0);
  const Row = staticModel({ data: { count } });
  const app = scope();
  const rows = modelDefinitionBindingOf(Row)!.collection(app);
  const previous = count.defaultValue!.value;
  try {
    count.defaultValue!.value = 5;
    expect(rows[modelDefaultCreator]!("row")).toBeUndefined();
    expect(scoped(app, () => Row.create({ id: "row" }).count.value)).toBe(5);
  } finally {
    count.defaultValue!.value = previous;
  }
});

it("keeps constructor-only default rows isolated and restores snapshot values without onCreate", () => {
  const Row = staticModel({ name: "DefaultOnlySnapshot", data: { count: f.number(0) } });
  const server = scope();
  scoped(server, () => Row.create({ id: "row", count: 9 }));
  const snapshot = serialize(server);
  const restored = scope({ snapshot }),
    fresh = scope();
  const restoredRows = modelDefinitionBindingOf(Row)!.collection(restored);
  const freshRows = modelDefinitionBindingOf(Row)!.collection(fresh);
  const restoredRow = restoredRows[modelDefaultCreator]!("row");
  const freshRow = freshRows[modelDefaultCreator]!("row");
  expect(restoredRow).not.toBe(freshRow);
  expect(freshRows[modelDefaultCreator]!("row")).toBe(freshRow);
  expect(scoped(restored, () => Row.get("row")!.count.value)).toBe(9);
  expect(scoped(fresh, () => Row.get("row")!.count.value)).toBe(0);
  expect(scoped(fresh, () => Row.where(Row.count.eq(0)).toArray())).toEqual([freshRow]);
  expect(serialize(restored)).toEqual(snapshot);
  scoped(fresh, () => (Row.get("row")!.count.value = 3));
  expect(scoped(restored, () => Row.get("row")!.count.value)).toBe(9);
  expect(scoped(fresh, () => Row.where(Row.count.eq(3)).first)).toBe(freshRow);
});
