import { TypeSystemPolicy } from "@sinclair/typebox/system";
import { expect, it } from "vitest";
import { scope, scoped } from "../../lib";
import { f, model, staticModel } from "../../lib/models";

it("keeps cached primitive creation checks sensitive to later schema constraints", () => {
  const count = f.number(0),
    title = f.string("");
  const Row = staticModel({ data: { count, title } });
  const minimum = Object.getOwnPropertyDescriptor(count.schema, "minimum");
  const length = Object.getOwnPropertyDescriptor(title.schema, "minLength");
  try {
    scoped(scope(), () => {
      Row.create({ id: "warm", count: 1, title: "a" });
      count.schema.minimum = 5;
      title.schema.minLength = 3;
      expect(() => Row.create({ id: "small", count: 1, title: "valid" })).toThrow(
        'invalid "count"',
      );
      expect(() => Row.create({ id: "short", count: 5, title: "a" })).toThrow('invalid "title"');
      expect(Row.create({ id: "valid", count: 5, title: "valid" }).count.value).toBe(5);
    });
  } finally {
    if (minimum) Object.defineProperty(count.schema, "minimum", minimum);
    else delete count.schema.minimum;
    if (length) Object.defineProperty(title.schema, "minLength", length);
    else delete title.schema.minLength;
  }
});

it("honors TypeBox's current numeric policy after warming the creation plan", () => {
  const Row = staticModel({ data: { count: f.number(0) } });
  const previous = TypeSystemPolicy.AllowNaN;
  try {
    scoped(scope(), () => {
      Row.create({ count: 1 });
      TypeSystemPolicy.AllowNaN = true;
      expect(Row.create({ count: NaN }).count.value).toBeNaN();
      TypeSystemPolicy.AllowNaN = false;
      expect(() => Row.create({ count: NaN })).toThrow('invalid "count"');
    });
  } finally {
    TypeSystemPolicy.AllowNaN = previous;
  }
});

for (const define of [model, staticModel]) {
  it(`${define.name} checks only required constructor keys while keeping replace and batch validation atomic`, () => {
    const Row = define({ data: { title: f.string(), count: f.number(0) } });
    scoped(scope(), () => {
      const row = Row.create({ id: "existing", title: "first" });
      expect(Row.create({ id: "existing", count: 2 })).toBe(row);
      expect(row.title.value).toBe("first");
      expect(() => Row.create({ id: "existing", count: 3 }, { replace: true })).toThrow(
        "missing keys: title",
      );
      expect(row.count.value).toBe(2);
      expect(() =>
        Row.create([
          { id: "new", title: "valid" },
          { id: "invalid", count: 1 },
        ] as never),
      ).toThrow("missing keys: title");
      expect(Row.get("new")).toBeNull();
      expect(Row.get("invalid")).toBeNull();
    });
  });
}
