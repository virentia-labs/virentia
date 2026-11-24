import { describe, expect, it } from "vitest";
import { scope, scoped, serialize, store } from "../../lib";
import { f, model, staticModel } from "../../lib/models";
import { collection } from "../../lib/models/collection";
import { instanceInternalOf } from "../../lib/models/definition";

describe("native model scope snapshots", () => {
  it("keeps registered field defaults logical while preserving SID restoration and explicit undefined", () => {
    const Model = staticModel({
      name: "LogicalModelDefaults",
      data: { count: f.number(0), data: f.any(1) },
    });
    const app = scope();
    const row = scoped(app, () => Model.create({ id: "row" }));
    const values = instanceInternalOf(row)!.scope!.values;
    expect(values.size).toBe(0);
    expect(row.count.value).toBe(0);
    expect(row.data.value).toBe(1);
    expect(values.size).toBe(0);
    const snapshot = serialize(app);
    const restored = scope({ snapshot });
    const copy = scoped(restored, () => Model.create({ id: "row", count: 99, data: 99 }));
    expect(copy.count.value).toBe(0);
    expect(copy.data.value).toBe(1);
    expect(serialize(restored)).toEqual(snapshot);
    row.data.value = undefined;
    expect(row.data.value).toBeUndefined();
    expect(copy.data.value).toBe(1);
    expect(() => serialize(app)).toThrow(/unsupported undefined/);
  });

  it("preserves restored namespaces with slash-separated heads through rebind and disposal", async () => {
    const Row = staticModel({ name: "NestedNamespace", data: { count: f.number(0) } });
    const server = scope();
    scoped(server, () => Row.create({ id: "row", count: 7 }));
    const snapshot = serialize(server);
    const manifest = snapshot.__virentia_model_instances__ as unknown as Record<
      string,
      { id: string; automatic: boolean; key: string }[]
    >;
    const identity = manifest.NestedNamespace[0];
    const oldPrefix = identity.key;
    identity.key = "request/nested/row";
    for (const key of Object.keys(snapshot)) {
      if (!key.startsWith(oldPrefix + "/")) continue;
      snapshot[identity.key + key.slice(oldPrefix.length)] = snapshot[key];
      delete snapshot[key];
    }
    const client = scope({ snapshot });
    const row = scoped(client, () => Row.create({ id: "row", count: 99 }));
    expect(row.count.value).toBe(7);
    expect(serialize(client)).toEqual(snapshot);
    row.rebind("renamed");
    expect(serialize(client)["request/nested/row/model:NestedNamespace/field:count"]).toBe(7);
    await row.dispose();
    expect(Object.keys(serialize(client)).some((key) => key.startsWith("request/"))).toBe(false);
  });
  it("serializes untouched declaration defaults and restores them before explicit constructor input", () => {
    const Row = staticModel({
      name: "Defaults",
      data: { count: f.number(0), title: f.string("row") },
    });
    const app = scope();
    scoped(app, () => Row.create({ id: "row" }));
    const snapshot = serialize(app);
    expect(Object.values(snapshot)).toContain(0);
    expect(Object.values(snapshot)).toContain("row");
    const restored = scope({ snapshot });
    const row = scoped(restored, () => Row.create({ id: "row", count: 100, title: "client" }));
    expect(row.json()).toEqual({ id: "row", count: 0, title: "row" });
    expect(serialize(restored)).toEqual(snapshot);
  });
  it("shares field declarations without registering another instance's lazy members", () => {
    const Row = staticModel({
      name: "SharedFields",
      data: { count: f.number(0) },
      setup() {
        return { draft: store("", undefined, { sid: "draft" }) };
      },
    });
    const app = scope();
    const first = scoped(app, () => Row.create({ id: "a", count: 1 }));
    const second = scoped(app, () => Row.create({ id: "b", count: 2 }));
    first.draft.value = "only first";
    let snapshot = serialize(app);
    expect(Object.keys(snapshot).filter((key) => key.endsWith("/draft"))).toHaveLength(1);
    expect(Object.values(snapshot)).toContain(1);
    expect(Object.values(snapshot)).toContain(2);
    second.draft.value = "second";
    snapshot = serialize(app);
    expect(Object.keys(snapshot).filter((key) => key.endsWith("/draft"))).toHaveLength(2);
    first.dispose();
    expect(Object.values(serialize(app))).not.toContain("only first");
    expect(Object.values(serialize(app))).toContain("second");
  });

  for (const order of ["plain first", "model first"]) {
    it(`rejects a model/plain SID collision: ${order}`, () => {
      const Row = staticModel({ name: "Collision", data: { count: f.number(0) } });
      const probe = scope();
      scoped(probe, () => Row.create({ id: "row" }));
      const sid = Object.keys(serialize(probe)).find((key) => key.includes("/field:count"))!;
      expect(sid).toBeTypeOf("string");
      const plain = store(5, undefined, { sid });
      const app = scope();
      if (order === "plain first") {
        scoped(app, () => plain.value);
        expect(() => scoped(app, () => Row.create({ id: "row" }))).toThrow(/Duplicate store SID/);
        expect(serialize(app)).toEqual({ [sid]: 5 });
      } else {
        scoped(app, () => Row.create({ id: "row", count: 2 }));
        const before = serialize(app);
        expect(() => scoped(app, () => plain.value)).toThrow(/Duplicate store SID/);
        expect(serialize(app)).toEqual(before);
      }
    });
  }

  it("checks collisions between independent static definitions before registering a namespace", () => {
    const First = staticModel({ name: "Same", data: { count: f.number(1) } });
    const Second = staticModel({ name: "Same", data: { count: f.number(2) } });
    const app = scope();
    scoped(app, () => First.create({ id: "row" }));
    const before = serialize(app);
    expect(() => scoped(app, () => Second.create({ id: "row" }))).toThrow(/Duplicate store SID/);
    expect(serialize(app)).toEqual(before);
  });

  for (const define of [staticModel, model]) {
    it(`serializes object-valued ${define.name} constructor inputs`, () => {
      const Page = define({ name: "Page", data: { data: f.any() } });
      const app = scope();
      const instance = scoped(app, () => Page.create({ data: { title: "page" } }));
      expect(instance.data.value).toEqual({ title: "page" });
      expect(JSON.stringify(serialize(app))).toContain("page");
    });
    it(`restores ${define.name} fields, members and automatic IDs without a JSX transform`, () => {
      const Model = define({
        name: "Counter",
        data: { count: f.number(0) },
        setup() {
          return { draft: store("", undefined, { sid: "draft" }) };
        },
      });
      const server = scope();
      const a = scoped(server, () => Model.create({ count: 1 }));
      const b = scoped(server, () => Model.create({ count: 2 }));
      a.count.value = 3;
      b.count.value = 7;
      a.draft.value = "first";
      b.draft.value = "second";
      const state = serialize(server);
      const client = scope({ snapshot: state });
      const a2 = scoped(client, () => Model.create({ count: 0 }));
      const b2 = scoped(client, () => Model.create({ count: 0 }));
      expect([a2.id, b2.id]).toEqual([a.id, b.id]);
      expect([a2.count.value, b2.count.value]).toEqual([3, 7]);
      expect([a2.draft.value, b2.draft.value]).toEqual(["first", "second"]);
      expect(serialize(client)).toEqual(state);
    });

    it(`releases disposed ${define.name} SID registrations before reusing an explicit ID`, async () => {
      const Model = define({
        name: "Ephemeral",
        data: { count: f.number(0) },
        setup() {
          return { value: store("", undefined, { sid: "value" }) };
        },
      });
      const app = scope();
      const first = collection(Model, app).add({ id: "same", count: 1 });
      first.value.value = "old";
      await first.dispose();
      const next = collection(Model, app).add({ id: "same", count: 2 });
      expect(next.count.value).toBe(2);
      expect(next.value.value).toBe("");
      expect(JSON.stringify(serialize(app))).not.toContain("old");
    });
  }
});
