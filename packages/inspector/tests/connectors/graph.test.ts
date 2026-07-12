import { describe, expect, it } from "vitest";
import { createEffect, createEvent, createStore, fork } from "effector";
import { createConnectTracker, graphiteId } from "../support/effector-connection";

const { connect } = createConnectTracker();

describe("connectEffector graph", () => {
  it("exposes user-facing units as key nodes and hides operation nodes", () => {
    const $count = createStore(0, { name: "count" });
    const increment = createEvent<number>("increment");
    const doubleFx = createEffect({
      name: "doubleFx",
      handler: async (value: number) => value * 2,
    });

    $count.on(increment, (count, amount) => count + amount);

    const connection = connect({ channel: "test-graph", units: [$count, increment, doubleFx] });
    const snapshot = connection.snapshot();

    const byName = (name: string) => snapshot.nodes.find((node) => node.name === name);

    const countNode = byName("count");
    const incrementNode = byName("increment");
    const effectNode = byName("doubleFx");

    expect(countNode).toMatchObject({ type: "store", key: true, internal: false, writable: true });
    expect(incrementNode).toMatchObject({
      type: "event",
      key: true,
      internal: false,
      callable: true,
    });
    expect(effectNode).toMatchObject({
      type: "effect",
      key: true,
      internal: false,
      callable: true,
    });

    // Node ids are the raw effector graphite ids.
    expect(countNode?.id).toBe(graphiteId($count));
    expect(incrementNode?.id).toBe(graphiteId(increment));

    // Operation nodes (on/map/sample/...) are never emitted as graph nodes.
    expect(snapshot.nodes.some((node) => node.type === "on")).toBe(false);
    expect(snapshot.nodes.some((node) => node.type === "map")).toBe(false);

    // Derived effect sub-units exist but are non-key (hidden by default).
    const pending = snapshot.nodes.find((node) => node.name === "pending" && !node.key);
    expect(pending).toBeDefined();
    expect(pending?.internal).toBe(false);
  });

  it("connects units with a reactive edge flattened through the operation node", () => {
    const $count = createStore(0, { name: "count" });
    const increment = createEvent<number>("increment");

    $count.on(increment, (count, amount) => count + amount);

    const connection = connect({ channel: "test-edge", units: [$count, increment] });
    const snapshot = connection.snapshot();

    const incrementId = graphiteId(increment);
    const countId = graphiteId($count);

    expect(
      snapshot.edges.some(
        (edge) =>
          edge.kind === "reactive" && edge.source === incrementId && edge.target === countId,
      ),
    ).toBe(true);

    // Every edge endpoint must be a node in the snapshot (mirrors inspector guard).
    const nodeIds = new Set(snapshot.nodes.map((node) => node.id));
    for (const edge of snapshot.edges) {
      expect(nodeIds.has(edge.source)).toBe(true);
      expect(nodeIds.has(edge.target)).toBe(true);
    }
  });

  it("reports scopes passed in", () => {
    const increment = createEvent<number>("increment");
    const scope = fork();

    const connection = connect({
      channel: "test-scopes",
      units: [increment],
      scopes: [{ scope, name: "app" }],
    });

    expect(connection.snapshot().scopes).toEqual([expect.objectContaining({ name: "app" })]);
  });
});
