import { describe, expect, it } from "vitest";
import { scope, scoped } from "../../lib";
import { collectNodes } from "../../lib/graph/deps";
import { modelViewCaptureOf, modelViewSnapshotOf } from "../../lib/internal";
import { f, staticModel } from "../../lib/models";

// A view capture is `json()` of the instance as it is when read: renderers ask
// for it at mount and read it only if a view needs its props.

const Note = staticModel({
  name: "CaptureNote",
  data: { title: f.string(""), done: f.boolean(false) },
});

describe("model view capture", () => {
  it("serializes the instance as it is when read", () => {
    const app = scope();
    const note = scoped(app, () => Note.create({ id: "n", title: "first" }));
    const capture = modelViewCaptureOf(note)!;
    scoped(app, () => {
      note.title.value = "second";
    });
    expect(capture.read()).toEqual(modelViewSnapshotOf(note));
    expect(capture.read()).toEqual({ id: "n", title: "second", done: false });
  });

  it("tracks nothing when read inside a computation", () => {
    const app = scope();
    const note = scoped(app, () => Note.create({ id: "n", title: "first" }));
    const capture = modelViewCaptureOf(note)!;
    const { result, nodes } = scoped(app, () => collectNodes(() => capture.read()));
    expect(result.title).toBe("first");
    expect(nodes.size).toBe(0);
  });

  it("refuses to read a disposed instance", async () => {
    const app = scope();
    const note = scoped(app, () => Note.create({ id: "n" }));
    const capture = modelViewCaptureOf(note)!;
    await note.dispose();
    expect(() => capture.read()).toThrow(/disposed/);
  });
});
