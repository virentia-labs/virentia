import { describe, expect, it } from "vitest";
import { createEffect, createStore, withFactory } from "effector";
import { createEffectorGraph } from "../../lib/effector/graph";
import { createConnectTracker } from "../support/effector-connection";

const { connect } = createConnectTracker();

/**
 * Naming resolution for discovered units (virentia-labs/virentia#4, #5).
 *
 * - effector auto-assigns a numeric name ("1", "15", …) to units created
 *   without one — a bare number is not a meaningful display name;
 * - units created inside a registered factory carry the factory variable name
 *   in `declaration.region` (`withFactory({ name })`);
 * - with `addLoc`/`debugSids` builds, declarations carry `loc` and `sid`.
 */
describe("factory context from declaration.region (#4)", () => {
  it("exposes the nearest factory name in node meta", () => {
    const connection = connect({ channel: "test-naming-factory-meta" });

    withFactory({
      sid: "app.ts:cartModel",
      name: "cartModel",
      fn: () => createStore(0, { sid: "cart-x1", name: "$cart" }),
    });

    const node = connection
      .snapshot()
      .nodes.find((candidate) => candidate.name === "$cart");

    expect(node).toBeDefined();
    expect(node?.meta.factory).toBe("cartModel");
  });

  it("keeps the factory context for live units passed via addUnits", () => {
    const connection = connect({ channel: "test-naming-factory-live" });

    const $live = withFactory({
      sid: "app.ts:liveModel",
      name: "liveModel",
      fn: () => createStore(0, { sid: "live-x1" }),
    });

    connection.addUnits([$live]);

    const node = connection
      .snapshot()
      .nodes.find((candidate) => candidate.meta.factory === "liveModel" && candidate.type === "store");

    expect(node).toBeDefined();
    expect(node?.name).toBe("liveModel.store");
  });

  it("names an auto-named unit after its factory instead of the numeric id", () => {
    const connection = connect({ channel: "test-naming-factory-name" });

    withFactory({
      sid: "app.ts:anonModel",
      name: "anonModel",
      fn: () => createStore(0, { sid: "anon-x1" }),
    });

    const node = connection
      .snapshot()
      .nodes.find((candidate) => candidate.meta.factory === "anonModel" && candidate.type === "store");

    expect(node).toBeDefined();
    expect(node?.name).toBe("anonModel.store");
  });
});

describe("anonymous unit display-name fallbacks (#5)", () => {
  it("falls back name → factory → loc → sid → #id", () => {
    const graph = createEffectorGraph();

    graph.observe({ id: "9001", kind: "effect", derived: false, loc: "api/voiceProxy/api.ts:42:11" });
    graph.observe({ id: "9002", kind: "effect", derived: false, sid: "abc123" });
    graph.observe({ id: "9003", kind: "effect", derived: false });
    // effector's numeric auto-name must be treated as missing
    graph.observe({ id: "9004", kind: "effect", derived: false, name: "9004", sid: "def456" });

    const snapshot = graph.snapshot([]);
    const byId = (id: string) => snapshot.nodes.find((node) => node.id === id);

    expect(byId("9001")?.name).toBe("effect @ api/voiceProxy/api.ts:42:11");
    expect(byId("9002")?.name).toBe("effect (abc123)");
    expect(byId("9003")?.name).toBe("effect #9003");
    expect(byId("9004")?.name).toBe("effect (def456)");

    graph.dispose();
  });

  it("plumbs loc and sid into node meta", () => {
    const graph = createEffectorGraph();

    graph.observe({
      id: "9101",
      kind: "effect",
      derived: false,
      loc: "api/voiceProxy/api.ts:42:11",
      sid: "abc123",
    });

    const node = graph.snapshot([]).nodes.find((candidate) => candidate.id === "9101");

    expect(node?.meta.loc).toBe("api/voiceProxy/api.ts:42:11");
    expect(node?.meta.sid).toBe("abc123");

    graph.dispose();
  });

  it("a real anonymous effect does not surface a bare numeric name", () => {
    const connection = connect({ channel: "test-naming-real-anon" });

    const anonFx = createEffect(async () => {});
    void anonFx;

    const numericNamed = connection
      .snapshot()
      .nodes.filter((node) => node.key && /^\d+$/.test(node.name));

    expect(numericNamed).toEqual([]);
  });
});

describe("composeName option", () => {
  it("lets the app encode a farfetched-aware naming policy", () => {
    const connection = connect({
      channel: "test-naming-compose",
      composeName: ({ name, factory }) =>
        factory && name?.startsWith("ff.unnamed.")
          ? `ff.${factory}.${name.slice("ff.unnamed.".length)}`
          : undefined,
    });

    withFactory({
      sid: "session/rename.ts:renameSessionMutation",
      name: "renameSessionMutation",
      fn: () => createStore("initial", { name: "ff.unnamed.$status", sid: "compose-x1" }),
    });

    const node = connection
      .snapshot()
      .nodes.find((candidate) => candidate.name === "ff.renameSessionMutation.$status");

    expect(node).toBeDefined();
    expect(node?.meta.factory).toBe("renameSessionMutation");
  });

  it("falls back to the default chain when the composer returns undefined", () => {
    const connection = connect({
      channel: "test-naming-compose-fallback",
      composeName: () => undefined,
    });

    withFactory({
      sid: "app.ts:fallbackModel",
      name: "fallbackModel",
      fn: () => createStore(0, { sid: "fallback-x1" }),
    });

    const node = connection
      .snapshot()
      .nodes.find(
        (candidate) => candidate.meta.factory === "fallbackModel" && candidate.type === "store" && candidate.key,
      );

    expect(node?.name).toBe("fallbackModel.store");
  });
});
