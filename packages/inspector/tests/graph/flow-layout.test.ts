import { describe, expect, it } from "vitest";
import { createFlowLayout } from "../../lib/client/shared/graph";
import { edge, node, snapshot } from "../support/graph-fixtures";

const xOf = (layout: { id: string; x: number; y: number }[], id: string) =>
  layout.find((n) => n.id === id)!.x;
const posOf = (layout: { id: string; x: number; y: number }[], id: string) =>
  layout.find((n) => n.id === id)!;

describe("createFlowLayout", () => {
  it("returns no positions for an empty snapshot", () => {
    expect(createFlowLayout(snapshot([]))).toEqual([]);
  });

  describe("level assignment", () => {
    it("places a root with no incoming edges at level 0 (x=0)", () => {
      const layout = createFlowLayout(snapshot([node("a"), node("b")], [edge("a", "b")]));
      expect(xOf(layout, "a")).toBe(0);
    });

    it("assigns each downstream node the next level (x grows by 220 per level)", () => {
      const layout = createFlowLayout(
        snapshot([node("a"), node("b"), node("c")], [edge("a", "b"), edge("b", "c")]),
      );
      expect(xOf(layout, "a")).toBe(0);
      expect(xOf(layout, "b")).toBe(220);
      expect(xOf(layout, "c")).toBe(440);
    });

    it("uses the longest path when a node is reachable at several depths", () => {
      // c is reachable directly (a->c, depth 1) and via b (a->b->c, depth 2).
      const layout = createFlowLayout(
        snapshot(
          [node("a"), node("b"), node("c")],
          [edge("a", "b"), edge("a", "c"), edge("b", "c")],
        ),
      );
      expect(xOf(layout, "c")).toBe(440); // longest path wins -> level 2
    });
  });

  describe("placement within a level", () => {
    it("stacks nodes that share a level by their snapshot order (y = index * 86)", () => {
      // Two roots, no edges -> both at level 0, stacked vertically.
      const layout = createFlowLayout(snapshot([node("a"), node("b")]));
      expect(posOf(layout, "a")).toEqual({ id: "a", x: 0, y: 0 });
      expect(posOf(layout, "b")).toEqual({ id: "b", x: 0, y: 86 });
    });
  });

  // NOTE(prod-bug): createFlowLayout does NOT terminate on a cyclic graph.
  // Unlike createReactiveSelection (which carries a `visited` set), the level
  // BFS re-enqueues a node every time the longest path to it grows, and a cycle
  // makes that grow without bound — an infinite loop. Any test that calls
  // createFlowLayout on a graph with a cycle (e.g. a<->b) HANGS the whole run,
  // so there is deliberately no such test here. A devtools graph can be cyclic
  // (e.g. two units that react to each other), so this can hang the inspector UI.
  // Reported as a pinned prod bug, not executed as a test.
});
