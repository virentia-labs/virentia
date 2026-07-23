import { describe, expect, it } from "vitest";
import type { DevtoolsSnapshot } from "@virentia/core/devtools";
import { hideIsolatedNodes, hideNonKeyNodes } from "../../lib/client/modules/inspector/snapshotFilters";

function node(
  id: string,
  extra: Partial<DevtoolsSnapshot["nodes"][number]> = {},
): DevtoolsSnapshot["nodes"][number] {
  return {
    id,
    name: id,
    type: "store",
    key: true,
    callable: false,
    writable: true,
    internal: false,
    meta: {},
    ...extra,
  };
}

function edge(source: string, target: string): DevtoolsSnapshot["edges"][number] {
  return { id: `reactive:${source}->${target}`, source, target, kind: "reactive" };
}

function snapshot(partial: Partial<DevtoolsSnapshot>): DevtoolsSnapshot {
  return { nodes: [], edges: [], scopes: [], breakpoints: [], ...partial };
}

describe("hideIsolatedNodes", () => {
  it("drops nodes without reactive edges — key units included", () => {
    // Регрессия: key-юниты имели безусловный проходной билет, и в key-only
    // виде тумблер Show isolated не делал ничего.
    const input = snapshot({
      nodes: [node("linked-a"), node("linked-b"), node("stray-key"), node("stray", { key: false })],
      edges: [edge("linked-a", "linked-b")],
    });

    const result = hideIsolatedNodes(input);

    expect(result.nodes.map((n) => n.id)).toEqual(["linked-a", "linked-b"]);
  });

  it("keeps parents of connected nodes", () => {
    const input = snapshot({
      nodes: [node("parent"), node("child", { parentId: "parent" }), node("other")],
      edges: [edge("child", "other")],
    });

    const result = hideIsolatedNodes(input);

    expect(result.nodes.map((n) => n.id)).toEqual(["parent", "child", "other"]);
  });

  it("leaves an edge-less graph untouched instead of hiding everything", () => {
    const input = snapshot({ nodes: [node("a"), node("b")] });

    expect(hideIsolatedNodes(input)).toBe(input);
  });

  it("filters breakpoints and edges down to surviving nodes", () => {
    const input = snapshot({
      nodes: [node("a"), node("b"), node("stray")],
      edges: [edge("a", "b")],
      breakpoints: ["a", "stray"],
    });

    const result = hideIsolatedNodes(input);

    expect(result.breakpoints).toEqual(["a"]);
    expect(result.edges).toHaveLength(1);
  });
});

describe("hideNonKeyNodes", () => {
  it("keeps only key units and edges between them", () => {
    const input = snapshot({
      nodes: [node("a"), node("service", { key: false }), node("b")],
      edges: [edge("a", "service"), edge("a", "b")],
    });

    const result = hideNonKeyNodes(input);

    expect(result.nodes.map((n) => n.id)).toEqual(["a", "b"]);
    expect(result.edges.map((e) => e.id)).toEqual(["reactive:a->b"]);
  });
});
