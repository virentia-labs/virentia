import { describe, expect, it } from "vitest";
import { createReactiveSelection } from "../../lib/client/shared/graph";
import { edge, node, snapshot } from "../support/graph-fixtures";

const ids = (xs: string[]) => [...xs].sort();

describe("createReactiveSelection", () => {
  describe("when there is no usable selection", () => {
    it("returns null for a null selection", () => {
      expect(createReactiveSelection(snapshot([node("a")]), null)).toBeNull();
    });

    it("returns null for a selection id absent from the snapshot", () => {
      expect(createReactiveSelection(snapshot([node("a")]), "missing")).toBeNull();
    });
  });

  it("includes the selected node alone when it has no edges", () => {
    const result = createReactiveSelection(snapshot([node("a")]), "a");
    expect(result).toEqual({ nodeIds: ["a"], edgeIds: [] });
  });

  describe("forward reachability", () => {
    it("includes downstream nodes and the edges reaching them", () => {
      const snap = snapshot(
        [node("a"), node("b"), node("c")],
        [edge("a", "b"), edge("b", "c")],
      );
      const result = createReactiveSelection(snap, "a")!;
      expect(ids(result.nodeIds)).toEqual(["a", "b", "c"]);
      expect(ids(result.edgeIds)).toEqual(["reactive:a->b", "reactive:b->c"]);
    });

    it("does not include an upstream node when selecting the source", () => {
      const snap = snapshot([node("a"), node("b")], [edge("a", "b")]);
      const result = createReactiveSelection(snap, "a")!;
      expect(ids(result.nodeIds)).toEqual(["a", "b"]);
    });
  });

  describe("backward reachability", () => {
    it("includes upstream nodes and the edges reaching them", () => {
      const snap = snapshot(
        [node("a"), node("b"), node("c")],
        [edge("a", "b"), edge("b", "c")],
      );
      const result = createReactiveSelection(snap, "c")!;
      expect(ids(result.nodeIds)).toEqual(["a", "b", "c"]);
      expect(ids(result.edgeIds)).toEqual(["reactive:a->b", "reactive:b->c"]);
    });
  });

  describe("a diamond", () => {
    const snap = snapshot(
      [node("a"), node("b"), node("c"), node("d")],
      [edge("a", "b"), edge("a", "c"), edge("b", "d"), edge("c", "d")],
    );

    it("reaches both paths forward from the apex without revisiting the shared sink", () => {
      const result = createReactiveSelection(snap, "a")!;
      expect(ids(result.nodeIds)).toEqual(["a", "b", "c", "d"]);
      expect(result.edgeIds).toHaveLength(4);
    });

    it("reaches both paths backward from the sink", () => {
      const result = createReactiveSelection(snap, "d")!;
      expect(ids(result.nodeIds)).toEqual(["a", "b", "c", "d"]);
      expect(result.edgeIds).toHaveLength(4);
    });
  });

  describe("a disconnected node", () => {
    it("is excluded from the selection", () => {
      const snap = snapshot([node("a"), node("b"), node("x")], [edge("a", "b")]);
      const result = createReactiveSelection(snap, "a")!;
      expect(result.nodeIds).not.toContain("x");
    });
  });

  describe("a cycle", () => {
    it("terminates and includes every node taking part in it", () => {
      const snap = snapshot([node("a"), node("b")], [edge("a", "b"), edge("b", "a")]);
      const result = createReactiveSelection(snap, "a")!;
      expect(ids(result.nodeIds)).toEqual(["a", "b"]);
      expect(result.edgeIds).toHaveLength(2);
    });
  });
});
