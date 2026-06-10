import { describe, expect, it } from "vitest";
import { computed, createNode, effect, event, reaction, run, scope, scoped, store } from "../lib";
import {
  getDevtoolsNodeId,
  getVirentiaDevtoolsSnapshot,
  installVirentiaDevtools,
  nameScope,
  nameUnit,
  setVirentiaDevtoolsBreakpoints,
} from "../lib/devtools";

describe("devtools", () => {
  it("captures named units, scopes, and graph links", async () => {
    const devtools = installVirentiaDevtools({
      channel: "test-devtools-graph",
    });
    const appScope = scope();
    const incremented = event<number>("incremented");
    const count = store(0);
    const doubled = count.map((value) => value * 2);

    nameScope(appScope, "app");
    nameUnit(count, "count");
    nameUnit(doubled, "doubled");

    reaction({
      on: incremented,
      name: "applyIncrement",
      run(amount) {
        count.value += amount;
      },
    });

    await scoped(appScope, () => incremented(2));

    const snapshot = devtools.snapshot();

    expect(snapshot.scopes).toContainEqual(
      expect.objectContaining({
        name: "app",
      }),
    );
    expect(snapshot.nodes).toContainEqual(
      expect.objectContaining({
        name: "incremented",
        type: "event",
      }),
    );
    expect(snapshot.nodes).toContainEqual(
      expect.objectContaining({
        name: "count",
        type: "store",
      }),
    );
    expect(snapshot.edges.length).toBeGreaterThan(0);

    devtools.dispose();
  });

  it("captures units created before devtools install and collapses computed internals", () => {
    const count = store(1, undefined, { name: "count" });
    const doubled = computed(() => count.value * 2, undefined, { name: "doubled" });
    const devtools = installVirentiaDevtools({
      channel: "test-devtools-preinstalled-units",
    });
    const snapshot = devtools.snapshot();
    const countNode = snapshot.nodes.find((node) => node.name === "count");
    const doubledNode = snapshot.nodes.find((node) => node.name === "doubled");

    expect(doubled.node).toBeDefined();
    expect(countNode).toEqual(
      expect.objectContaining({
        type: "store",
      }),
    );
    expect(doubledNode).toEqual(
      expect.objectContaining({
        type: "computed",
      }),
    );
    expect(snapshot.nodes.some((node) => node.type === "computed.invalidate")).toBe(false);
    expect(snapshot.edges).toContainEqual(
      expect.objectContaining({
        source: countNode?.id,
        target: doubledNode?.id,
      }),
    );

    devtools.dispose();
  });

  it("deduplicates stale named units recreated by hot reload", () => {
    store(0, undefined, { name: "counter.count" });
    computed(() => 1, undefined, { name: "counter.doubled" });

    const nextCount = store(1, undefined, { name: "counter.count" });
    const nextDoubled = computed(() => nextCount.value * 2, undefined, {
      name: "counter.doubled",
    });
    const devtools = installVirentiaDevtools({
      channel: "test-devtools-deduplicate-named-units",
    });
    const snapshot = devtools.snapshot();
    const countNodes = snapshot.nodes.filter((node) => node.name === "counter.count");
    const doubledNodes = snapshot.nodes.filter((node) => node.name === "counter.doubled");

    expect(nextDoubled.node).toBeDefined();
    expect(countNodes).toHaveLength(1);
    expect(doubledNodes).toHaveLength(1);
    expect(snapshot.edges).toContainEqual(
      expect.objectContaining({
        source: countNodes[0]?.id,
        target: doubledNodes[0]?.id,
      }),
    );

    devtools.dispose();
  });

  it("links effect subunits to their parent effect without exposing internals", () => {
    const searchFx = effect(async (query: string) => query, "searchFx");
    const devtools = installVirentiaDevtools({
      channel: "test-devtools-effect-subunits",
    });
    const snapshot = devtools.snapshot();
    const effectNode = snapshot.nodes.find((node) => node.name === "searchFx");
    const startedNode = snapshot.nodes.find((node) => node.name === "searchFx.started");

    expect(searchFx.node).toBeDefined();
    expect(effectNode).toEqual(expect.objectContaining({ type: "effect" }));
    expect(startedNode).toEqual(
      expect.objectContaining({
        parentId: effectNode?.id,
        parentRole: "started",
      }),
    );
    expect(snapshot.nodes.some((node) => node.type === "effect.execute")).toBe(false);
    expect(snapshot.nodes.some((node) => node.type === "effect.settle")).toBe(false);
    expect(snapshot.edges).toContainEqual(
      expect.objectContaining({
        source: effectNode?.id,
        target: startedNode?.id,
        kind: "owner",
      }),
    );

    devtools.dispose();
  });

  it("marks key units in snapshots", () => {
    const submitted = event<number>({ name: "submitted", key: true });
    const count = store(0, undefined, { name: "count", key: true });
    const doubled = computed(() => count.value * 2, undefined, { name: "doubled", key: true });
    const saveFx = effect(async (value: number) => value, { name: "saveFx", key: true });
    const devtools = installVirentiaDevtools({
      channel: "test-devtools-key-units",
    });
    const snapshot = devtools.snapshot();

    expect(submitted.node).toBeDefined();
    expect(doubled.node).toBeDefined();
    expect(saveFx.node).toBeDefined();
    expect(snapshot.nodes).toContainEqual(
      expect.objectContaining({
        name: "submitted",
        key: true,
      }),
    );
    expect(snapshot.nodes).toContainEqual(
      expect.objectContaining({
        name: "count",
        key: true,
      }),
    );
    expect(snapshot.nodes).toContainEqual(
      expect.objectContaining({
        name: "doubled",
        key: true,
      }),
    );
    expect(snapshot.nodes).toContainEqual(
      expect.objectContaining({
        name: "saveFx",
        key: true,
      }),
    );

    devtools.dispose();
  });

  it("stops a chain after a selected breakpoint node", async () => {
    const devtools = installVirentiaDevtools({
      channel: "test-devtools-breakpoint",
    });

    const calls: string[] = [];
    const first = createNode({
      run(ctx) {
        calls.push("first");
        return ctx.value;
      },
    });
    const second = createNode({
      run(ctx) {
        calls.push("second");
        return ctx.value;
      },
    });

    first.next = [second];
    nameUnit(first, "first");
    nameUnit(second, "second");
    setVirentiaDevtoolsBreakpoints([getDevtoolsNodeId(first)]);

    await run({ unit: first, payload: 1 });

    expect(calls).toEqual(["first"]);
    expect(getVirentiaDevtoolsSnapshot().breakpoints).toContain(getDevtoolsNodeId(first));

    devtools.setBreakpoints([]);
    devtools.dispose();
  });
});
