import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import { scope, scoped } from "../../lib/index";
import { collection, f, staticModel } from "../../lib/models";
import type { Props } from "../../lib/models";

// §4.8: any type assembles from `f.*` — combinators compose SCHEMAS (wire
// validation) and CODECS (value conversion) recursively. `f.array(f.date())`
// is Date[] in the model and ISO strings on the wire, per element.

function app<T>(fn: () => T): T {
  return scoped(scope(), fn) as T;
}

const ISO_A = "2026-08-08T10:00:00.000Z";
const ISO_B = "2027-01-01T00:00:00.000Z";

describe("f.array", () => {
  it("composes the item codec: Date[] in the model, ISO[] on the wire", () => {
    const Log: any = staticModel({
      data: { marks: f.array(f.date(), []) },
    });

    app(() => {
      const logs: any = collection(Log);
      const log = logs.add({ marks: [ISO_A, ISO_B] });

      expect(log.marks.value).toHaveLength(2);
      expect(log.marks.value[0]).toBeInstanceOf(Date);
      expect(log.marks.value[0].toISOString()).toBe(ISO_A);
      expect(log.json().marks).toEqual([ISO_A, ISO_B]); // round-trip
    });
  });

  it("validates elements against the item schema", () => {
    const Log: any = staticModel({ data: { marks: f.array(f.number(), []) }, name: "log" });

    app(() => {
      const logs: any = collection(Log);

      expect(() => logs.add({ marks: [1, "two"] })).toThrowError(/invalid "marks"/);
    });
  });

  it("f.list stays as an alias", () => {
    expect(f.list).toBe(f.array);
  });

  it("plain item types skip codec allocation entirely", () => {
    const field: any = f.array(f.number(), []);

    expect(field["~def"].codec).toBeUndefined();
  });
});

describe("f.object over a shape of fields", () => {
  it("converts per key and keeps unknown-free wire validation", () => {
    const Task: any = staticModel({
      data: {
        meta: f.object({
          due: f.date(),
          note: f.string(),
        }),
      },
    });

    app(() => {
      const tasks: any = collection(Task);
      const task = tasks.add({ meta: { due: ISO_A, note: "hi" } });

      expect(task.meta.value.due).toBeInstanceOf(Date);
      expect(task.meta.value.note).toBe("hi");
      expect(task.json().meta).toEqual({ due: ISO_A, note: "hi" });

      expect(() => tasks.add({ meta: { due: ISO_A, note: 42 } })).toThrowError(/invalid "meta"/);
    });
  });

  it("still accepts a ready-made TypeBox schema", () => {
    const Task: any = staticModel({
      data: { box: f.object(Type.Object({ n: Type.Number() }), { n: 0 }) },
    });

    app(() => {
      const task = (collection(Task) as any).add({ box: { n: 5 } });

      expect(task.box.value).toEqual({ n: 5 });
    });
  });
});

describe("f.tuple", () => {
  it("keeps per-position types and conversions", () => {
    const Event: any = staticModel({
      data: { entry: f.tuple([f.string(), f.date()]) },
    });

    app(() => {
      const events: any = collection(Event);
      const event = events.add({ entry: ["deploy", ISO_A] });

      expect(event.entry.value[0]).toBe("deploy");
      expect(event.entry.value[1]).toBeInstanceOf(Date);
      expect(event.json().entry).toEqual(["deploy", ISO_A]);

      expect(() => events.add({ entry: ["deploy"] })).toThrowError(/invalid "entry"/);
    });
  });
});

describe("f.record", () => {
  it("converts per entry", () => {
    const Plan: any = staticModel({
      data: { slots: f.record(f.date(), {}) },
    });

    app(() => {
      const plan = (collection(Plan) as any).add({ slots: { a: ISO_A, b: ISO_B } });

      expect(plan.slots.value.a).toBeInstanceOf(Date);
      expect(plan.json().slots).toEqual({ a: ISO_A, b: ISO_B });
    });
  });
});

describe("f.union and f.intersect", () => {
  it("union of plain types validates and passes through", () => {
    const Setting: any = staticModel({
      data: { value: f.union([f.string(), f.number()]) },
      name: "setting",
    });

    app(() => {
      const settings: any = collection(Setting);

      settings.add({ value: "dark" });
      settings.add({ value: 3 });

      expect(() => settings.add({ value: true })).toThrowError(/invalid "value"/);
    });
  });

  it("discriminated object unions work through literals", () => {
    const Shape: any = staticModel({
      data: {
        geometry: f.union([
          f.object({ kind: f.literal("circle"), r: f.number() }),
          f.object({ kind: f.literal("rect"), w: f.number(), h: f.number() }),
        ]),
      },
    });

    app(() => {
      const shapes: any = collection(Shape);
      const s = shapes.add({ geometry: { kind: "circle", r: 2 } });

      expect(s.geometry.value).toEqual({ kind: "circle", r: 2 });
    });
  });

  it("variants with value transforms are a declaration error", () => {
    expect(() => f.union([f.string(), f.date()])).toThrowError(/f\.union.*not supported/);
    expect(() => f.intersect([f.object({ a: f.date() })])).toThrowError(/f\.intersect/);
  });

  it("intersect merges object schemas", () => {
    const Entity: any = staticModel({
      data: {
        both: f.intersect([
          f.object({ a: f.string() }),
          f.object({ b: f.number() }),
        ]),
      },
      name: "entity",
    });

    app(() => {
      const entities: any = collection(Entity);
      const e = entities.add({ both: { a: "x", b: 1 } });

      expect(e.both.value).toEqual({ a: "x", b: 1 });
      expect(() => entities.add({ both: { a: "x" } })).toThrowError(/invalid "both"/);
    });
  });
});

describe("scalars: integer, null, any, unknown, numeric enum", () => {
  it("f.integer rejects fractions; f.enum takes number literals", () => {
    const Slot: any = staticModel({
      data: {
        at: f.integer(0),
        level: f.enum([1, 2, 3], 1),
      },
      name: "slot",
    });

    app(() => {
      const slots: any = collection(Slot);

      slots.add({ at: 5, level: 3 });
      expect(() => slots.add({ at: 1.5 })).toThrowError(/invalid "at"/);
      expect(() => slots.add({ level: 4 })).toThrowError(/invalid "level"/);
    });
  });

  it("f.any and f.unknown pass anything; f.null only null", () => {
    const Box: any = staticModel({
      data: {
        blob: f.any(null),
        tag: f.null(null),
      },
      name: "box",
    });

    app(() => {
      const boxes: any = collection(Box);
      const b = boxes.add({ blob: { deep: [1, "x"] }, tag: null });

      expect(b.blob.value).toEqual({ deep: [1, "x"] });
      expect(() => boxes.add({ tag: "nope" })).toThrowError(/invalid "tag"/);
    });
  });
});

describe("f.recursive", () => {
  it("validates trees against the self-referential schema", () => {
    interface Node {
      label: string;
      children: Node[];
    }

    const Doc: any = staticModel({
      data: {
        outline: f.recursive<Node>((self) =>
          f.object({ label: f.string(), children: f.array(self) }),
        ),
      },
      name: "doc",
    });

    app(() => {
      const docs: any = collection(Doc);
      const doc = docs.add({
        outline: { label: "root", children: [{ label: "leaf", children: [] }] },
      });

      expect(doc.outline.value.children[0].label).toBe("leaf");
      expect(() =>
        docs.add({ outline: { label: "root", children: [{ label: 1, children: [] }] } }),
      ).toThrowError(/invalid "outline"/);
    });
  });

  it("a recursive body with transforms is a declaration error", () => {
    expect(() =>
      f.recursive((self) => f.object({ at: f.date(), children: f.array(self) })),
    ).toThrowError(/f\.recursive.*not supported/);
  });
});

describe("nesting depth and composition edges", () => {
  it("codecs compose through arrays of objects of tuples", () => {
    const Track: any = staticModel({
      data: {
        segments: f.array(
          f.object({
            span: f.tuple([f.date(), f.date()]),
            name: f.string(),
          }),
          [],
        ),
      },
    });

    app(() => {
      const tracks: any = collection(Track);
      const track = tracks.add({
        segments: [{ span: [ISO_A, ISO_B], name: "s1" }],
      });

      const [segment] = track.segments.value;

      expect(segment.span[0]).toBeInstanceOf(Date);
      expect(segment.span[1]).toBeInstanceOf(Date);
      expect(track.json().segments).toEqual([{ span: [ISO_A, ISO_B], name: "s1" }]);
    });
  });

  it("optional composite fields pass null through untouched", () => {
    const Log: any = staticModel({
      data: { marks: f.array(f.date()).optional() },
    });

    app(() => {
      const log = (collection(Log) as any).add({ marks: null });

      expect(log.marks.value).toBeNull();
      expect(log.json().marks).toBeNull();
    });
  });

  it("a user .map on a composite field takes over the whole conversion", () => {
    const Log: any = staticModel({
      data: (p: Props<{ marks: string }>) => ({
        // wire: comma-joined string; the structural array codec must NOT run
        marks: f.array(f.date(), p.marks.map(
          (wire) => wire.split(",").map((iso) => new Date(iso)),
          (value) => value.map((date: Date) => date.toISOString()).join(","),
        )),
      }),
    });

    app(() => {
      const log = (collection(Log) as any).add({ marks: `${ISO_A},${ISO_B}` });

      expect(log.marks.value[0]).toBeInstanceOf(Date);
      expect(log.json().marks).toBe(`${ISO_A},${ISO_B}`);
    });
  });

  it(".meta annotations land in the schema for codec reflection", () => {
    const field: any = f.integer(0).meta({ mc: { wire: "varint" } });

    expect(field["~def"].schema.mc).toEqual({ wire: "varint" });

    const composed: any = f.array(f.integer().meta({ mc: { wire: "u8" } }));

    expect(composed["~def"].schema.items.mc).toEqual({ wire: "u8" });
  });

  it("raw TypeBox schemas work as combinator items", () => {
    const Doc: any = staticModel({
      data: { pairs: f.array(Type.Tuple([Type.String(), Type.Number()]), []) },
      name: "doc",
    });

    app(() => {
      const docs: any = collection(Doc);
      const doc = docs.add({ pairs: [["a", 1]] });

      expect(doc.pairs.value).toEqual([["a", 1]]);
      expect(() => docs.add({ pairs: [["a", "b"]] })).toThrowError(/invalid "pairs"/);
    });
  });
});
