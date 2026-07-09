import { afterEach, describe, expect, it, vi } from "vitest";
import { computed, effect, event, reaction, scope, scoped, store } from "../../lib";
import { node, run } from "../../lib/internal";
import {
  getInspectorBreakpoints,
  isInspectorEnabled,
  onInspectorEvent,
  registerInspectorScope,
  annotateInspectorScope,
  setInspectorBreakpoints,
} from "../../lib/kernel/inspector";
import type { Scope } from "../../lib/scope";
import {
  defaultDevtoolsChannel,
  describeUnit,
  getDevtoolsNodeId,
  getDevtoolsScopeId,
  getVirentiaDevtoolsSnapshot,
  installVirentiaDevtools,
  nameScope,
  nameUnit,
  openVirentiaDevtools,
  setVirentiaDevtoolsBreakpoints,
} from "../../lib/devtools";
import { readChannelFromLocation } from "../../lib/devtools/transport";
import {
  inboundEnvelope,
  makeFakeCtor,
  messages,
  messagesOfType,
  recordingTransport,
} from "../support/devtools-transport";
import { microtasks, uniqueChannel, uniqueName, waitUntil } from "../support/devtools-harness";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  // The kernel breakpoint set is process-global; clear it so a stray breakpoint
  // from one test cannot stop chains in another.
  setInspectorBreakpoints([]);
});

describe("devtools inspector", () => {
  describe("on install", () => {
    it("synchronously sends an app message then a graph", () => {
      const transport = recordingTransport();
      const bridge = installVirentiaDevtools({ channel: uniqueChannel(), transport });

      expect(messages(transport)[0]?.type).toBe("app");
      expect(messages(transport)[1]?.type).toBe("graph");

      bridge.dispose();
    });

    it("defaults the app name to 'Virentia app' and the channel to the default", () => {
      const transport = recordingTransport();
      const bridge = installVirentiaDevtools({ transport });

      const app = messagesOfType(transport, "app")[0]!;
      expect(app.appName).toBe("Virentia app");
      expect(bridge.channel).toBe(defaultDevtoolsChannel);

      bridge.dispose();
    });

    it("uses a provided transport verbatim but builds a relay only when it is omitted", () => {
      const fake = makeFakeCtor();
      vi.stubGlobal("WebSocket", fake.ctor);

      const nullBridge = installVirentiaDevtools({ channel: uniqueChannel(), transport: null });
      expect(fake.state.constructs).toBe(0);
      expect(nullBridge.snapshot()).toBeDefined();
      nullBridge.dispose();

      const relayBridge = installVirentiaDevtools({ channel: uniqueChannel() });
      expect(fake.state.constructs).toBe(1);
      relayBridge.dispose();
    });

    it("debounces node and scope creation into a single graph send per microtask", async () => {
      const transport = recordingTransport();
      const bridge = installVirentiaDevtools({ channel: uniqueChannel(), transport });

      await microtasks();
      const before = messagesOfType(transport, "graph").length;

      // Three fresh named units in one synchronous tick.
      nameUnit(store(0), uniqueName("a"));
      nameUnit(store(0), uniqueName("b"));
      nameUnit(store(0), uniqueName("c"));

      await microtasks();
      const after = messagesOfType(transport, "graph").length;
      expect(after - before).toBe(1);

      bridge.dispose();
    });

    it("skips a queued graph when disposed before the microtask flushes", async () => {
      const transport = recordingTransport();
      const bridge = installVirentiaDevtools({ channel: uniqueChannel(), transport });

      await microtasks();
      const before = messagesOfType(transport, "graph").length;

      // Arm the queue, then dispose before the microtask runs.
      nameUnit(store(0), uniqueName("armed"));
      bridge.dispose();

      await microtasks();
      expect(messagesOfType(transport, "graph").length).toBe(before);
    });
  });

  describe("on a node run", () => {
    it("maps a completed node into a single timeline event", async () => {
      const transport = recordingTransport();
      const bridge = installVirentiaDevtools({ channel: uniqueChannel(), transport });

      const unit = node({
        run(ctx) {
          return ctx.value;
        },
      });
      const name = uniqueName("plain");
      nameUnit(unit, name);

      await run({ unit, payload: 5 });

      const timelines = messagesOfType(transport, "timeline").map((message) => message.event);
      const mine = timelines.filter((event) => event.nodeName === name);
      expect(mine).toHaveLength(1);
      expect(mine[0]).toMatchObject({
        breakpoint: false,
        failed: false,
        stopped: false,
        nodeType: "node",
      });
      expect(typeof mine[0]!.duration).toBe("number");
      expect(typeof mine[0]!.timestamp).toBe("number");

      bridge.dispose();
    });

    it("emits nothing for a node-start", async () => {
      const transport = recordingTransport();
      const bridge = installVirentiaDevtools({ channel: uniqueChannel(), transport });

      const unit = node({
        run(ctx) {
          return ctx.value;
        },
      });
      nameUnit(unit, uniqueName("solo"));

      const before = messagesOfType(transport, "timeline").length;
      await run({ unit, payload: 1 });
      const after = messagesOfType(transport, "timeline").length;

      // Exactly one timeline (the node-end); node-start produced nothing.
      expect(after - before).toBe(1);

      bridge.dispose();
    });

    it("numbers timeline events with a strictly increasing per-bridge sequence", async () => {
      const transport = recordingTransport();
      const bridge = installVirentiaDevtools({ channel: uniqueChannel(), transport });

      const first = node({ run: (ctx) => ctx.value });
      const second = node({ run: (ctx) => ctx.value });
      nameUnit(first, uniqueName("seq-first"));
      nameUnit(second, uniqueName("seq-second"));

      await run({ unit: first, payload: 1 });
      await run({ unit: second, payload: 2 });

      const events = messagesOfType(transport, "timeline").map((message) => message.event);
      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({ sequence: 1, id: "timeline:1" });
      expect(events[1]).toMatchObject({ sequence: 2, id: "timeline:2" });

      bridge.dispose();
    });

    it("falls back to a `${type} #n` name for an unnamed node", async () => {
      const transport = recordingTransport();
      const bridge = installVirentiaDevtools({ channel: uniqueChannel(), transport });

      const unit = node({ run: (ctx) => ctx.value });
      const id = getDevtoolsNodeId(unit); // node:<n>

      await run({ unit, payload: 1 });

      const event = messagesOfType(transport, "timeline")
        .map((message) => message.event)
        .find((candidate) => candidate.nodeId === id);
      expect(event).toBeDefined();
      expect(event!.nodeType).toBe("node");
      expect(event!.nodeName).toBe(`node ${id.replace("node:", "#")}`);

      bridge.dispose();
    });

    it("emits a breakpoint event followed by a node-end event on each hit", async () => {
      const transport = recordingTransport();
      const bridge = installVirentiaDevtools({ channel: uniqueChannel(), transport });

      const calls: string[] = [];
      const first = node({
        run(ctx) {
          calls.push("first");
          return ctx.value;
        },
      });
      const second = node({
        run(ctx) {
          calls.push("second");
          return ctx.value;
        },
      });
      first.next = [second];
      const firstName = uniqueName("bp-first");
      nameUnit(first, firstName);
      nameUnit(second, uniqueName("bp-second"));
      bridge.setBreakpoints([getDevtoolsNodeId(first)]);

      await run({ unit: first, payload: 1 });

      expect(calls).toEqual(["first"]);

      const firstId = getDevtoolsNodeId(first);
      const events = messagesOfType(transport, "timeline")
        .map((message) => message.event)
        .filter((event) => event.nodeId === firstId);

      expect(events).toHaveLength(2);

      const breakpointEvent = events.find((event) => event.breakpoint);
      expect(breakpointEvent).toMatchObject({
        breakpoint: true,
        stopped: true,
        failed: false,
        duration: 0,
        nodeName: firstName,
      });

      const nodeEndEvent = events.find((event) => !event.breakpoint);
      expect(nodeEndEvent).toMatchObject({ breakpoint: false, stopped: true });

      bridge.setBreakpoints([]);
      bridge.dispose();
    });
  });

  describe("on an inbound message", () => {
    it("resends app then graph on a 'ready'", () => {
      const transport = recordingTransport();
      const channel = uniqueChannel();
      const bridge = installVirentiaDevtools({ channel, transport });

      transport.sent.length = 0;
      transport.deliver(inboundEnvelope(channel, { type: "ready" }));

      const kinds = messages(transport).map((message) => message.type);
      expect(kinds).toEqual(["app", "graph"]);

      bridge.dispose();
    });

    it("resends the graph on a 'request-graph'", () => {
      const transport = recordingTransport();
      const channel = uniqueChannel();
      const bridge = installVirentiaDevtools({ channel, transport });

      transport.sent.length = 0;
      transport.deliver(inboundEnvelope(channel, { type: "request-graph" }));

      expect(messages(transport).map((message) => message.type)).toEqual(["graph"]);

      bridge.dispose();
    });

    it("applies set-breakpoints then resends the graph", () => {
      const transport = recordingTransport();
      const channel = uniqueChannel();
      const bridge = installVirentiaDevtools({ channel, transport });

      const unit = node({ run: (ctx) => ctx.value });
      const id = getDevtoolsNodeId(unit);
      nameUnit(unit, uniqueName("bp-visible"));

      transport.sent.length = 0;
      transport.deliver(inboundEnvelope(channel, { type: "set-breakpoints", nodeIds: [id] }));

      expect(messagesOfType(transport, "graph")).toHaveLength(1);
      expect(bridge.snapshot().breakpoints).toContain(id);

      bridge.setBreakpoints([]);
      bridge.dispose();
    });

    it("replies to a trigger-unit with a trigger-result echoing the requestId", async () => {
      const transport = recordingTransport();
      const channel = uniqueChannel();
      const bridge = installVirentiaDevtools({ channel, transport });

      const ran: number[] = [];
      const unit = node({
        run(ctx) {
          ran.push(ctx.value as number);
          return ctx.value;
        },
      });
      const id = getDevtoolsNodeId(unit);

      transport.deliver(
        inboundEnvelope(channel, {
          type: "trigger-unit",
          requestId: "req-42",
          nodeId: id,
          payload: 7,
        }),
      );

      await waitUntil(() => messagesOfType(transport, "trigger-result").length > 0);

      const result = messagesOfType(transport, "trigger-result")[0]!;
      expect(result.requestId).toBe("req-42");
      expect(result.result).toEqual({ ok: true });
      // A falsy scopeId runs with scope null (the unit still executed).
      expect(ran).toEqual([7]);

      bridge.dispose();
    });

    it("fails a trigger-unit for an unknown node", async () => {
      const transport = recordingTransport();
      const channel = uniqueChannel();
      const bridge = installVirentiaDevtools({ channel, transport });

      transport.deliver(
        inboundEnvelope(channel, {
          type: "trigger-unit",
          requestId: "req-unknown",
          nodeId: "node:does-not-exist",
        }),
      );

      await waitUntil(() => messagesOfType(transport, "trigger-result").length > 0);

      const result = messagesOfType(transport, "trigger-result")[0]!.result;
      expect(result.ok).toBe(false);
      expect(result.error?.kind).toBe("error");
      expect(result.error?.preview).toContain("Unknown node:");

      bridge.dispose();
    });

    it("fails a trigger-unit for an unknown scope", async () => {
      const transport = recordingTransport();
      const channel = uniqueChannel();
      const bridge = installVirentiaDevtools({ channel, transport });

      const unit = node({ run: (ctx) => ctx.value });
      const id = getDevtoolsNodeId(unit);

      transport.deliver(
        inboundEnvelope(channel, {
          type: "trigger-unit",
          requestId: "req-scope",
          nodeId: id,
          scopeId: "scope:nope",
        }),
      );

      await waitUntil(() => messagesOfType(transport, "trigger-result").length > 0);

      const result = messagesOfType(transport, "trigger-result")[0]!.result;
      expect(result.ok).toBe(false);
      expect(result.error?.preview).toContain("Unknown scope:");

      bridge.dispose();
    });

    it("reports the serialized error from a throwing unit", async () => {
      const transport = recordingTransport();
      const channel = uniqueChannel();
      const bridge = installVirentiaDevtools({ channel, transport });

      const unit = node({
        run() {
          throw new Error("kaboom");
        },
      });
      const id = getDevtoolsNodeId(unit);

      transport.deliver(
        inboundEnvelope(channel, {
          type: "trigger-unit",
          requestId: "req-throw",
          nodeId: id,
        }),
      );

      await waitUntil(() => messagesOfType(transport, "trigger-result").length > 0);

      const result = messagesOfType(transport, "trigger-result")[0]!.result;
      expect(result.ok).toBe(false);
      expect(result.error).toMatchObject({ kind: "error", preview: "Error: kaboom" });

      bridge.dispose();
    });
  });

  describe("lifecycle", () => {
    it("is idempotent on dispose", () => {
      const transport = recordingTransport();
      const bridge = installVirentiaDevtools({ channel: uniqueChannel(), transport });

      expect(() => {
        bridge.dispose();
        bridge.dispose();
      }).not.toThrow();
    });

    it("returns null from open() in a non-browser host", () => {
      const bridge = installVirentiaDevtools({ channel: uniqueChannel(), transport: null });
      expect(bridge.open()).toBeNull();
      bridge.dispose();

      const opened = openVirentiaDevtools({ channel: uniqueChannel(), transport: null });
      expect(opened.open()).toBeNull();
      opened.dispose();
    });

    it("returns the default channel from readChannelFromLocation in a non-browser host", () => {
      expect(readChannelFromLocation()).toBe(defaultDevtoolsChannel);
    });

    it("stays enabled until the last bridge is disposed", () => {
      const a = installVirentiaDevtools({ channel: uniqueChannel(), transport: null });
      const b = installVirentiaDevtools({ channel: uniqueChannel(), transport: null });

      expect(isInspectorEnabled()).toBe(true);

      a.dispose();
      expect(isInspectorEnabled()).toBe(true);

      b.dispose();
      expect(isInspectorEnabled()).toBe(false);
    });
  });

  describe("the global registry", () => {
    it("accumulates units across installs and disposals", () => {
      const name = uniqueName("ga");
      const a = installVirentiaDevtools({ channel: uniqueChannel(), transport: null });
      store(0, undefined, { name });
      a.dispose();

      const b = installVirentiaDevtools({ channel: uniqueChannel(), transport: null });
      const snapshot = b.snapshot();
      expect(snapshot.nodes.some((graphNode) => graphNode.name === name)).toBe(true);

      b.dispose();
    });

    it("filters snapshot breakpoints to visible nodes while keeping the raw stop set", () => {
      const hidden = node({ run: (ctx) => ctx.value });
      describeUnit(hidden, { internal: true, name: uniqueName("hidden-bp") });
      const hiddenId = getDevtoolsNodeId(hidden);

      setVirentiaDevtoolsBreakpoints([hiddenId]);

      const snapshot = getVirentiaDevtoolsSnapshot();
      expect(snapshot.breakpoints).not.toContain(hiddenId);
      // The underlying kernel set still holds the id (execution would still stop).
      expect(getInspectorBreakpoints()).toContain(hiddenId);
    });
  });

  describe("scope registration", () => {
    it("emits scope-created only for a new scope while assigning a stable id", () => {
      const events: Array<{ type: string }> = [];
      const unsubscribe = onInspectorEvent((event) => {
        if (event.type === "scope-created") {
          events.push(event);
        }
      });

      const target = scope();
      registerInspectorScope(target);
      const firstCount = events.length;
      registerInspectorScope(target);

      expect(firstCount).toBe(events.length); // no extra emit for a known scope
      expect(getDevtoolsScopeId(target)).toMatch(/^scope:\d+$/);

      unsubscribe();
    });

    it("treats a null or undefined scope as a no-op", () => {
      const before = getVirentiaDevtoolsSnapshot().scopes.length;
      const events: unknown[] = [];
      const unsubscribe = onInspectorEvent((event) => {
        if (event.type === "scope-created") {
          events.push(event);
        }
      });

      registerInspectorScope(null);
      registerInspectorScope(undefined);

      expect(events).toHaveLength(0);
      expect(getVirentiaDevtoolsSnapshot().scopes.length).toBe(before);

      unsubscribe();
    });

    it("re-announces a scope on annotate, emitting creation only when enabled", () => {
      // Case A: subscribing enables the inspector, so a scope created afterwards
      // emits scope-created at creation, and annotate re-announces it -> two emits.
      const emittedA: Scope[] = [];
      const unsubscribeA = onInspectorEvent((event) => {
        if (event.type === "scope-created") {
          emittedA.push(event.scope);
        }
      });

      const known = scope();
      registerInspectorScope(known); // already registered at creation -> no extra emit
      annotateInspectorScope(known, { name: uniqueName("known") });
      expect(emittedA.filter((candidate) => candidate === known)).toHaveLength(2);

      // Removing the last listener disables the inspector again.
      unsubscribeA();

      // Case B: a scope registered (silently) while disabled is still "known", so
      // annotate emits exactly once via the guarded already-known branch. The
      // observer is attached after creation, so a creation emit (if any) is not
      // counted — annotate must contribute exactly one.
      const fresh = scope();
      const emittedB: Scope[] = [];
      const unsubscribeB = onInspectorEvent((event) => {
        if (event.type === "scope-created" && event.scope === fresh) {
          emittedB.push(event.scope);
        }
      });

      annotateInspectorScope(fresh, { name: uniqueName("fresh") });
      expect(emittedB).toHaveLength(1);

      unsubscribeB();
    });

    it("shows an annotated scope name, falling back to `scope #n` when unnamed", () => {
      const named = scope();
      const unnamed = scope();
      getDevtoolsScopeId(named);
      getDevtoolsScopeId(unnamed);
      nameScope(named, "app-scope-name");

      const scopes = getVirentiaDevtoolsSnapshot().scopes;
      const namedId = getDevtoolsScopeId(named);
      const unnamedId = getDevtoolsScopeId(unnamed);

      expect(scopes.find((candidate) => candidate.id === namedId)?.name).toBe("app-scope-name");
      expect(scopes.find((candidate) => candidate.id === unnamedId)?.name).toMatch(/^scope #\d+$/);
    });
  });
});

describe("graph snapshot", () => {
  it("captures named units, scopes, and their edges", async () => {
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

  it("collapses computed internals for units created before install", () => {
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

  it("marks key units in the snapshot", () => {
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
    const first = node({
      run(ctx) {
        calls.push("first");
        return ctx.value;
      },
    });
    const second = node({
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
