import { afterEach, describe, expect, it } from "vitest";
import { allSettled, createEffect, createEvent, createStore, fork } from "effector";
import type { DevtoolsTimelineEvent } from "@virentia/core/devtools";
import { connectEffector, type EffectorInspectorConnection } from "../lib/effector";
import { createEffectorGraph } from "../lib/effector/graph";
import { createEffectorTimeline } from "../lib/effector/timeline";
import { triggerEffectorUnit } from "../lib/effector/trigger";

const graphiteId = (unit: unknown): string =>
  String((unit as { graphite: { id: string } }).graphite.id);

const connections: EffectorInspectorConnection[] = [];

const connect = (...args: Parameters<typeof connectEffector>): EffectorInspectorConnection => {
  const connection = connectEffector(...args);
  connections.push(connection);
  return connection;
};

afterEach(() => {
  while (connections.length) {
    connections.pop()?.dispose();
  }
});

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

  it("reports scopes passed in and echoes inert breakpoints filtered to existing nodes", () => {
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

describe("createEffectorTimeline", () => {
  const drain = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  it("maps user-facing computations to timeline events and filters operation nodes", async () => {
    const events: DevtoolsTimelineEvent[] = [];
    const timeline = createEffectorTimeline({ onEvent: (event) => events.push(event) });

    const $count = createStore(0, { name: "count" });
    const increment = createEvent<number>("increment");
    $count.on(increment, (count, amount) => count + amount);

    const scope = fork();
    timeline.subscribeScope({ id: "scope:1", scope, name: "app" });

    await allSettled(increment, { scope, params: 5 });
    await drain();

    const incrementRow = events.find((event) => event.nodeName === "increment");
    expect(incrementRow).toBeDefined();
    expect(incrementRow).toMatchObject({
      nodeType: "event",
      scopeId: "scope:1",
      scopeName: "app",
      failed: false,
      stopped: false,
      breakpoint: false,
      duration: 0,
    });
    expect(incrementRow?.payload.preview).toBe("5");
    expect(incrementRow?.result.preview).toBe("5");
    expect(incrementRow?.id).toMatch(/^timeline:\d+$/);

    // No operation-node rows leak into the timeline.
    expect(events.some((event) => event.nodeType === "on")).toBe(false);
    // No derived service sub-unit rows leak in (store's "updates", etc.).
    expect(events.some((event) => event.nodeName === "updates")).toBe(false);

    timeline.dispose();
  });

  it("emits one primary row per effect call instead of every derived sub-unit", async () => {
    const events: DevtoolsTimelineEvent[] = [];
    const timeline = createEffectorTimeline({ onEvent: (event) => events.push(event) });

    const okFx = createEffect({ name: "okFx", handler: async (value: number) => value * 2 });

    const scope = fork();
    timeline.subscribeScope({ id: "scope:1", scope, name: "app" });

    await allSettled(okFx, { scope, params: 4 });
    await drain();

    expect(events.filter((event) => event.nodeName === "okFx")).toHaveLength(1);
    for (const noisy of ["updates", "inFlight", "pending", "finally", "done", "doneData"]) {
      expect(events.some((event) => event.nodeName === noisy)).toBe(false);
    }

    timeline.dispose();
  });

  it("flags failed effects and reducer throws", async () => {
    const events: DevtoolsTimelineEvent[] = [];
    const timeline = createEffectorTimeline({ onEvent: (event) => events.push(event) });

    const boomFx = createEffect({
      name: "boomFx",
      handler: async () => {
        throw new Error("kaboom");
      },
    });

    const scope = fork();
    timeline.subscribeScope({ id: "scope:1", scope, name: "app" });

    await allSettled(boomFx, { scope }).catch(() => {});
    await drain();

    const failedRow = events.find((event) => event.failed);
    expect(failedRow).toBeDefined();
    expect(failedRow?.result.preview).toContain("kaboom");
    // Failure rows are still attributed to user-facing units, not op nodes.
    expect(events.some((event) => event.nodeType === "on" || event.nodeType === "map")).toBe(false);

    timeline.dispose();
  });
});

describe("triggerEffectorUnit", () => {
  it("triggers an event in a scope and reports success", async () => {
    const $count = createStore(0, { name: "count" });
    const increment = createEvent<number>("increment");
    $count.on(increment, (count, amount) => count + amount);

    const graph = createEffectorGraph();
    graph.addUnits([$count, increment]);
    const scope = fork();
    const entry = graph.addScope(scope, "app");

    const result = await triggerEffectorUnit(
      {
        type: "trigger-unit",
        requestId: "r1",
        nodeId: graphiteId(increment),
        scopeId: entry.id,
        payload: 7,
      },
      graph,
    );

    expect(result).toEqual({ ok: true });
    expect(scope.getState($count)).toBe(7);

    graph.dispose();
  });

  it("awaits effect settlement and surfaces failures", async () => {
    const okFx = createEffect({ name: "okFx", handler: async (value: number) => value * 2 });
    const failFx = createEffect({
      name: "failFx",
      handler: async () => {
        throw new Error("nope");
      },
    });

    const graph = createEffectorGraph();
    graph.addUnits([okFx, failFx]);
    const scope = fork();
    const entry = graph.addScope(scope);

    const okResult = await triggerEffectorUnit(
      {
        type: "trigger-unit",
        requestId: "r1",
        nodeId: graphiteId(okFx),
        scopeId: entry.id,
        payload: 3,
      },
      graph,
    );
    expect(okResult).toEqual({ ok: true });

    const failResult = await triggerEffectorUnit(
      {
        type: "trigger-unit",
        requestId: "r2",
        nodeId: graphiteId(failFx),
        scopeId: entry.id,
        payload: 0,
      },
      graph,
    );
    expect(failResult.ok).toBe(false);
    expect(failResult.error?.preview).toContain("nope");

    graph.dispose();
  });

  it("rejects unknown nodes and scopes", async () => {
    const increment = createEvent<number>("increment");
    const graph = createEffectorGraph();
    graph.addUnits([increment]);

    const unknownNode = await triggerEffectorUnit(
      { type: "trigger-unit", requestId: "r1", nodeId: "does-not-exist", payload: 1 },
      graph,
    );
    expect(unknownNode.ok).toBe(false);
    expect(unknownNode.error?.preview).toContain("Unknown node");

    const unknownScope = await triggerEffectorUnit(
      {
        type: "trigger-unit",
        requestId: "r2",
        nodeId: graphiteId(increment),
        scopeId: "scope:nope",
        payload: 1,
      },
      graph,
    );
    expect(unknownScope.ok).toBe(false);
    expect(unknownScope.error?.preview).toContain("Unknown scope");

    graph.dispose();
  });

  it("triggers an effect with no scope by calling the unit directly", async () => {
    let ran = 0;
    const sideFx = createEffect({
      name: "sideFx",
      handler: async (value: number) => {
        ran += value;
      },
    });

    const graph = createEffectorGraph();
    graph.addUnits([sideFx]);

    const result = await triggerEffectorUnit(
      {
        type: "trigger-unit",
        requestId: "r1",
        nodeId: graphiteId(sideFx),
        scopeId: null,
        payload: 9,
      },
      graph,
    );

    expect(result).toEqual({ ok: true });
    expect(ran).toBe(9);

    graph.dispose();
  });
});

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
