import { describe, expect, it } from "vitest";
import { scope, scoped } from "../../lib";
import { f, staticModel } from "../../lib/models";
import { sequenceBindingOf, type SequenceOperation } from "../../lib/sequence";

// A batch creation reaches a query's subscribers as one change: an unsorted
// query appends its new rows in one operation, a sorted or limited one edits
// row by row. Either way the rows end up where a one-by-one creation puts them.

const Row = staticModel({
  name: "BulkCreatedRow",
  data: { rank: f.number(0), label: f.string("") },
});

function watch<T extends { id: string }>(source: unknown) {
  const sequence = sequenceBindingOf<T>(source)!;
  const rows = sequence.snapshot().map((row) => row.id);
  const operations: string[] = [];
  const stop = sequence.subscribe((batch: readonly SequenceOperation<T>[]) => {
    for (const operation of batch) {
      operations.push(
        JSON.stringify(operation, (key, value) =>
          key === "items" ? (value as T[]).map((item) => item.id) : value,
        ),
      );
      if (operation.type === "insert")
        rows.splice(operation.index, 0, ...operation.items.map((item) => item.id));
      else if (operation.type === "remove") rows.splice(operation.index, operation.count);
    }
  });
  return { rows, operations, stop };
}

describe("a batch creation", () => {
  it("appends its rows to an unsorted query in one operation", () => {
    const app = scope();
    scoped(app, () => Row.create({ id: "first" }));
    const all = watch(scoped(app, () => Row.instances));
    const filtered = watch(scoped(app, () => Row.where(Row.rank.eq(1))));
    scoped(app, () =>
      Row.create([
        { id: "a", rank: 1 },
        { id: "b", rank: 2 },
        { id: "c", rank: 1 },
      ]),
    );
    expect(all.operations).toEqual(['{"type":"insert","index":1,"items":["a","b","c"]}']);
    expect(all.rows).toEqual(["first", "a", "b", "c"]);
    expect(filtered.operations).toEqual(['{"type":"insert","index":0,"items":["a","c"]}']);
    expect(filtered.rows).toEqual(["a", "c"]);
    all.stop();
    filtered.stop();
  });

  it("edits a sorted or limited query row by row, to the same rows", () => {
    const app = scope();
    const sorted = watch(scoped(app, () => Row.sort(Row.rank.desc)));
    const limited = watch(scoped(app, () => Row.take(2)));
    scoped(app, () =>
      Row.create([
        { id: "a", rank: 1 },
        { id: "b", rank: 3 },
        { id: "c", rank: 2 },
      ]),
    );
    expect(sorted.operations).toHaveLength(3);
    expect(sorted.rows).toEqual(["b", "c", "a"]);
    expect(limited.rows).toEqual(["a", "b"]);
    expect(scoped(app, () => Row.instances.items.map((row) => row.id))).toEqual(["a", "b", "c"]);
    sorted.stop();
    limited.stop();
  });

  it("merges into existing rows without moving them, and leaves nothing on failure", () => {
    const app = scope();
    scoped(app, () => Row.create({ id: "kept", label: "old" }));
    const all = watch(scoped(app, () => Row.instances));
    scoped(app, () => Row.create([{ id: "kept", label: "new" }, { id: "fresh" }]));
    expect(all.rows).toEqual(["kept", "fresh"]);
    expect(scoped(app, () => Row.get("kept")!.label.value)).toBe("new");
    // Rejected before any row is created: listeners see nothing.
    expect(() =>
      scoped(app, () => Row.create([{ id: "x" }, { id: "y", rank: "high" as never }])),
    ).toThrow();
    expect(all.rows).toEqual(["kept", "fresh"]);
    expect(scoped(app, () => Row.instances.count)).toBe(2);
    all.stop();
  });
});
