import { describe, expect, it } from "vitest";
import type { DevtoolsSnapshot } from "@virentia/core/devtools";
import { capSnapshot } from "../../lib/client/modules/inspector/capSnapshot";

function node(id: string, key = false): DevtoolsSnapshot["nodes"][number] {
  return {
    id,
    name: id,
    type: "store",
    key,
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

describe("capSnapshot", () => {
  it("returns the snapshot untouched when under the limit", () => {
    const input = snapshot({ nodes: [node("a"), node("b")], edges: [edge("a", "b")] });
    const result = capSnapshot(input, 10);

    expect(result.snapshot).toBe(input);
    expect(result.hiddenCount).toBe(0);
    expect(result.totalCount).toBe(2);
  });

  it("prefers connected nodes, then key nodes, then the rest", () => {
    const input = snapshot({
      nodes: [
        node("stray-1"),
        node("key-1", true),
        node("linked-a"),
        node("stray-2"),
        node("linked-b"),
        node("key-2", true),
      ],
      edges: [edge("linked-a", "linked-b")],
    });

    const result = capSnapshot(input, 4);
    const keptIds = result.snapshot.nodes.map((n) => n.id);

    expect(keptIds).toEqual(["linked-a", "linked-b", "key-1", "key-2"]);
    expect(result.hiddenCount).toBe(2);
    expect(result.totalCount).toBe(6);
  });

  it("drops edges and breakpoints pointing at removed nodes", () => {
    const input = snapshot({
      nodes: [node("a"), node("b"), node("stray-1"), node("stray-2")],
      edges: [edge("a", "b")],
      breakpoints: ["a", "stray-1"],
    });

    const result = capSnapshot(input, 2);

    expect(result.snapshot.nodes.map((n) => n.id)).toEqual(["a", "b"]);
    expect(result.snapshot.edges).toHaveLength(1);
    expect(result.snapshot.breakpoints).toEqual(["a"]);
  });

  it("keeps snapshot order inside a priority bucket (stable)", () => {
    const input = snapshot({
      nodes: [node("k1", true), node("k2", true), node("k3", true)],
    });

    const result = capSnapshot(input, 2);

    expect(result.snapshot.nodes.map((n) => n.id)).toEqual(["k1", "k2"]);
  });
});
