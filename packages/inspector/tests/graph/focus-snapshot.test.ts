import { describe, expect, it } from "vitest";
import type { DevtoolsSnapshot } from "@virentia/core/devtools";
import { focusSnapshot } from "../../lib/client/modules/inspector/focusSnapshot";

function node(id: string): DevtoolsSnapshot["nodes"][number] {
  return {
    id,
    name: id,
    type: "store",
    key: true,
    callable: false,
    writable: true,
    internal: false,
    meta: {},
  };
}

function edge(source: string, target: string): DevtoolsSnapshot["edges"][number] {
  return { id: `reactive:${source}->${target}`, source, target, kind: "reactive" };
}

function snapshot(partial: Partial<DevtoolsSnapshot>): DevtoolsSnapshot {
  return { nodes: [], edges: [], scopes: [], breakpoints: [], ...partial };
}

describe("focusSnapshot", () => {
  it("returns null without a focused node or for an unknown id", () => {
    const input = snapshot({ nodes: [node("a")] });

    expect(focusSnapshot(input, null)).toBeNull();
    expect(focusSnapshot(input, "missing")).toBeNull();
  });

  it("keeps the transitive upstream and downstream of the focused node", () => {
    // caller-root -> caller -> focused -> dependent -> dependent-leaf,
    // caller -> sibling (не в цепочке focused), stray без связей.
    const input = snapshot({
      nodes: [
        node("caller-root"),
        node("caller"),
        node("focused"),
        node("dependent"),
        node("dependent-leaf"),
        node("sibling"),
        node("stray"),
      ],
      edges: [
        edge("caller-root", "caller"),
        edge("caller", "focused"),
        edge("focused", "dependent"),
        edge("dependent", "dependent-leaf"),
        edge("caller", "sibling"),
      ],
    });

    const result = focusSnapshot(input, "focused");

    expect(result?.nodes.map((n) => n.id)).toEqual([
      "caller-root",
      "caller",
      "focused",
      "dependent",
      "dependent-leaf",
    ]);
  });

  it("drops branches not reachable from the focused node", () => {
    const input = snapshot({
      nodes: [node("caller"), node("focused"), node("dependent"), node("stray-a"), node("stray-b")],
      edges: [edge("caller", "focused"), edge("focused", "dependent"), edge("stray-a", "stray-b")],
      breakpoints: ["focused", "stray-a"],
    });

    const result = focusSnapshot(input, "focused");

    expect(result?.nodes.map((n) => n.id)).toEqual(["caller", "focused", "dependent"]);
    expect(result?.edges.map((e) => e.id)).toEqual([
      "reactive:caller->focused",
      "reactive:focused->dependent",
    ]);
    expect(result?.breakpoints).toEqual(["focused"]);
  });
});
