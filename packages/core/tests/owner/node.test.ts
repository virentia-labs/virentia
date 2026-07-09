import { afterEach, describe, expect, it } from "vitest";
import { node } from "../../lib/internal";
import {
  getInspectorNodeById,
  getInspectorNodeId,
  isInspectorEnabled,
  onInspectorEvent,
  type InspectorEvent,
} from "../../lib/kernel/inspector";

describe("node()", () => {
  it("wraps a fn as run with no other own fields", () => {
    const fn = (): number => 1;
    const n = node(fn);

    expect(n.run).toBe(fn);
    expect(Object.keys(n)).toEqual(["run"]);
  });

  it("returns a shallow copy of the options with a distinct identity", () => {
    const opts = { run() {}, next: [] };
    const n = node(opts);

    expect(n).not.toBe(opts);
    expect(n.run).toBe(opts.run);

    n.enabled = false;
    expect((opts as { enabled?: unknown }).enabled).toBeUndefined();
  });

  it("returns a fresh empty node with no argument", () => {
    const n = node();

    expect(n.run).toBeUndefined();
    expect(typeof n).toBe("object");
    expect(n).not.toBe(node()); // each call is a fresh object
  });

  it("shares next and meta references with the options in its shallow copy", () => {
    const next: never[] = [];
    const meta = {};
    const n = node({ next, meta });

    expect(n.next).toBe(next);
    expect(n.meta).toBe(meta);

    next.push();
    expect(n.next).toBe(next);
  });

  it("registers with the inspector at creation even when disabled", () => {
    expect(isInspectorEnabled()).toBe(false);

    const n = node();
    const id = getInspectorNodeId(n);

    expect(id).toMatch(/^node:\d+$/);
    // Stable across repeated reads and resolvable back to the same node.
    expect(getInspectorNodeId(n)).toBe(id);
    expect(getInspectorNodeById(id)).toBe(n);
  });

  it("emits node-created with distinct ids when the inspector is enabled", () => {
    const events: InspectorEvent[] = [];
    const off = onInspectorEvent((e) => events.push(e));

    try {
      const a = node();
      const b = node();

      const created = events.filter((e) => e.type === "node-created");
      expect(created.some((e) => (e as { node: unknown }).node === a)).toBe(true);
      expect(created.some((e) => (e as { node: unknown }).node === b)).toBe(true);

      expect(getInspectorNodeId(a)).not.toBe(getInspectorNodeId(b));
    } finally {
      off();
    }
  });

  afterEach(() => {
    // onInspectorEvent auto-disables once its last listener unsubscribes, but be
    // explicit so a later disabled-state assertion never flakes.
    expect(isInspectorEnabled()).toBe(false);
  });
});
