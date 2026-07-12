import { describe, expect, it } from "vitest";
import { createEffect, createEvent, createStore, fork } from "effector";
import { createEffectorGraph } from "../../lib/effector/graph";
import { triggerEffectorUnit } from "../../lib/effector/trigger";
import { graphiteId } from "../support/effector-connection";

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
