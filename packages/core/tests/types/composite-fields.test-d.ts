import { Type } from "@sinclair/typebox";
import { describe, expectTypeOf, it } from "vitest";
import { collection, f, staticModel } from "../../lib/models";
import type { Dto } from "../../lib/models";

// §4.8 at the type level: combinators compose VALUE types (what the instance
// holds) separately from WIRE types (what Dto carries) — f.array(f.date())
// is Date[] in the model and string[] in the Dto.

describe("composite value and wire types", () => {
  const Track = staticModel({
    data: {
      marks: f.array(f.date(), []),
      meta: f.object({ due: f.date(), note: f.string() }),
      entry: f.tuple([f.string(), f.number()]),
      value: f.union([f.string(), f.number()]),
      slots: f.record(f.integer(), {}),
      level: f.enum([1, 2, 3], 1),
      pairs: f.array(Type.Tuple([Type.String(), Type.Number()]), []),
    },
  });

  it("instance values compose through combinators", () => {
    const track = collection(Track).add({
      meta: { due: "2026-08-08T10:00:00.000Z", note: "x" },
      entry: ["a", 1],
      value: "dark",
    });

    expectTypeOf(track.marks.value).toEqualTypeOf<Date[]>();
    expectTypeOf(track.meta.value.due).toEqualTypeOf<Date>();
    expectTypeOf(track.meta.value.note).toEqualTypeOf<string>();
    expectTypeOf(track.entry.value).toEqualTypeOf<[string, number]>();
    expectTypeOf(track.value.value).toEqualTypeOf<string | number>();
    expectTypeOf(track.slots.value).toEqualTypeOf<Record<string, number>>();
    expectTypeOf(track.level.value).toEqualTypeOf<1 | 2 | 3>();
    expectTypeOf(track.pairs.value).toEqualTypeOf<[string, number][]>();
  });

  it("wire types differ where conversions apply", () => {
    type TrackDto = Dto<typeof Track>;

    expectTypeOf<TrackDto["marks"]>().toEqualTypeOf<string[] | undefined>();
    expectTypeOf<TrackDto["meta"]>().toEqualTypeOf<{ due: string; note: string }>();
    expectTypeOf<TrackDto["entry"]>().toEqualTypeOf<[string, number]>();
  });

  it("wrong shapes are rejected at add", () => {
    const tracks = collection(Track);
    const meta = { due: "2026-08-08T10:00:00.000Z", note: "y" };

    // @ts-expect-error marks carries ISO strings on the wire, not Dates
    tracks.add({ meta, entry: ["a", 1], value: 1, marks: [new Date()] });

    // @ts-expect-error tuple positions are fixed
    tracks.add({ meta, entry: [1, "a"], value: 1 });
  });
});
