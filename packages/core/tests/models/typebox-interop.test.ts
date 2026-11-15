import { CloneType, Type } from "@sinclair/typebox";
import { TypeSystemPolicy } from "@sinclair/typebox/system";
import { expect, it } from "vitest";
import { scope, scoped } from "../../lib";
import { f, staticModel, trait } from "../../lib/models";

it.each(["default", "clone", "freeze"] as const)(
  "keeps TypeBox's %s instance policy and raw-schema validation",
  (mode) => {
    const previous = TypeSystemPolicy.InstanceMode;
    try {
      TypeSystemPolicy.InstanceMode = mode;
      const leaf = Type.String({ minLength: 2 });
      const payload = f.object({ title: leaf, counts: f.array(f.integer()) });
      expect(payload.schema).toEqual(
        Type.Object({ title: leaf, counts: Type.Array(Type.Integer()) }),
      );
      expect(payload.schema.properties.title === leaf).toBe(mode === "default");
      expect(Object.isFrozen(payload.schema)).toBe(mode === "freeze");
      const Row = staticModel({ data: { payload } });
      scoped(scope(), () => {
        const valid = { title: "ok", counts: [1, 2] };
        expect(Row.create({ payload: valid }).payload.value).toEqual(valid);
        expect(() => Row.create({ payload: { title: "x", counts: [1] } })).toThrow(
          'invalid "payload"',
        );
        expect(() => Row.create({ payload: { title: "ok", counts: [1.5] } })).toThrow(
          'invalid "payload"',
        );
      });
    } finally {
      TypeSystemPolicy.InstanceMode = previous;
    }
  },
);

it("instantiates raw TypeBox arguments inside nested trait schemas without changing the original", () => {
  const schema = Type.Object({
    optional: Type.Readonly(Type.Optional(Type.Argument(0))),
    values: Type.Record(Type.String(), Type.Argument(0)),
    pair: Type.Tuple([Type.Argument(0), Type.Argument(0)]),
  });
  const original = CloneType(schema);
  const Generic = trait({ data: { payload: f.from(schema) } });
  const Applied = Generic(f.integer());
  expect(Applied.fields.get("payload")!.schema).toEqual(Type.Instantiate(schema, [Type.Integer()]));
  expect(schema).toEqual(original);
  const Row = staticModel({ data: { payload: f.from(Applied.fields.get("payload")!.schema) } });
  scoped(scope(), () => {
    const valid = { values: { first: 1 }, pair: [2, 3] };
    expect(Row.create({ payload: valid }).payload.value).toEqual(valid);
    expect(() => Row.create({ payload: { values: { first: "bad" }, pair: [2, 3] } })).toThrow(
      'invalid "payload"',
    );
    expect(() => Row.create({ payload: { values: { first: 1 }, pair: [2, "bad"] } })).toThrow(
      'invalid "payload"',
    );
  });
});
