import { describe, expect, it } from "vitest";
import { createEvent, createStore } from "effector";
import { createConnectTracker, graphiteId } from "../support/effector-connection";

const { connect } = createConnectTracker();

describe("effector graph degradation", () => {
  it("auto-discovers units created after connecting, without passing units", () => {
    const connection = connect({ channel: "test-auto-graph" });

    // inspectGraph reports units created after the connection is established.
    const createdAfter = createEvent<number>("createdAfterConnect");
    void createdAfter;

    expect(connection.snapshot().nodes.map((node) => node.name)).toContain("createdAfterConnect");
  });

  it("auto-discovers units that compute scope-less, without passing units", () => {
    const autoEvent = createEvent<number>("autoEvent");
    const autoStore = createStore(0, { name: "autoStore" }).on(autoEvent, (n, x) => n + x);
    void autoStore;

    const connection = connect({ channel: "test-auto-compute" });

    // A scope-less computation is seen by inspect() and registers the units.
    autoEvent(5);

    const names = connection.snapshot().nodes.map((node) => node.name);
    expect(names).toContain("autoEvent");
    expect(names).toContain("autoStore");
  });

  it("classifies service sub-units (reinit/updates) as non-key", () => {
    const $count = createStore(0, { name: "serviceCount" });
    const connection = connect({ channel: "test-service", units: [$count] });
    const snapshot = connection.snapshot();

    expect(snapshot.nodes.some((node) => node.name === "reinit" && node.key)).toBe(false);
    expect(snapshot.nodes.some((node) => node.name === "updates" && node.key)).toBe(false);
    // The user's store is still a key node.
    expect(snapshot.nodes.some((node) => node.name === "serviceCount" && node.key)).toBe(true);
  });

  it("discovers connections wired after units were registered", () => {
    const $count = createStore(0, { name: "lateCount" });
    const increment = createEvent<number>("lateIncrement");

    const connection = connect({ channel: "test-late", units: [$count, increment] });

    const incrementId = graphiteId(increment);
    const countId = graphiteId($count);
    const hasEdge = () =>
      connection
        .snapshot()
        .edges.some(
          (edge) =>
            edge.kind === "reactive" && edge.source === incrementId && edge.target === countId,
        );

    expect(hasEdge()).toBe(false);

    // Wire the units together AFTER registration; a fresh snapshot must see it.
    $count.on(increment, (count, amount) => count + amount);

    expect(hasEdge()).toBe(true);
  });
});
