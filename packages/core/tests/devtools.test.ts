import { describe, expect, it } from "vitest";
import { computed, createNode, effect, event, reaction, run, scope, scoped, store } from "../lib";
import {
  createRelayTransport,
  createWebSocketTransport,
  getDevtoolsNodeId,
  getVirentiaDevtoolsSnapshot,
  installVirentiaDevtools,
  nameScope,
  nameUnit,
  setVirentiaDevtoolsBreakpoints,
  type RelayTransport,
  type WebSocketConstructorLike,
} from "../lib/devtools";

describe("devtools", () => {
  it("routes traffic through a custom transport for non-browser hosts", () => {
    // React Native and other non-browser hosts have no window/BroadcastChannel;
    // the bridge must still reach the inspector through an injected transport.
    const sent: Array<{ message: { type: string } }> = [];
    const listeners = new Set<(message: unknown) => void>();
    const transport: RelayTransport = {
      dispose() {},
      onMessage(listener) {
        listeners.add(listener);

        return () => listeners.delete(listener);
      },
      send(message) {
        sent.push(message as { message: { type: string } });
      },
    };

    const devtools = installVirentiaDevtools({ channel: "rn", transport });

    // The initial app/graph handshake goes out over the custom transport.
    expect(sent.some((envelope) => envelope.message.type === "app")).toBe(true);

    // An inspector message arriving over the transport is handled and answered.
    const before = sent.length;

    for (const listener of listeners) {
      listener({
        __virentiaDevtools: true,
        id: "inspector-ready",
        channel: "rn",
        target: "app",
        message: { type: "ready" },
      });
    }

    expect(sent.length).toBeGreaterThan(before);

    devtools.dispose();
  });

  it("createWebSocketTransport works with an injected WebSocket in any environment", () => {
    const sent: string[] = [];
    const listeners: Record<string, (event: { data?: unknown }) => void> = {};
    const sockets: FakeWebSocket[] = [];

    class FakeWebSocket {
      readyState = 0; // CONNECTING

      constructor(public url: string) {
        sockets.push(this);
      }

      send(data: string): void {
        sent.push(data);
      }

      close(): void {
        this.readyState = 3; // CLOSED
      }

      addEventListener(type: string, listener: (event: { data?: unknown }) => void): void {
        listeners[type] = listener;
      }
    }

    const received: unknown[] = [];
    const transport = createWebSocketTransport("ws://example.test/__virentia_devtools", {
      webSocket: FakeWebSocket as unknown as WebSocketConstructorLike,
      reconnectDelay: 0,
    });
    const unsubscribe = transport.onMessage((message) => received.push(message));

    // Buffered while still connecting.
    transport.send({ hello: 1 });
    expect(sent).toEqual([]);

    // On open, the queue flushes.
    sockets[0]!.readyState = 1; // OPEN
    listeners.open?.({});
    expect(sent).toEqual([JSON.stringify({ hello: 1 })]);

    // Sends after open go straight through; incoming JSON is parsed.
    transport.send({ hello: 2 });
    listeners.message?.({ data: JSON.stringify({ from: "inspector" }) });
    expect(sent).toEqual([JSON.stringify({ hello: 1 }), JSON.stringify({ hello: 2 })]);
    expect(received).toEqual([{ from: "inspector" }]);

    unsubscribe();
    transport.dispose();
    expect(sockets[0]!.readyState).toBe(3);
  });

  it("builds a relay transport without a browser window", () => {
    // The relay is a plain WebSocket client, so it is available wherever
    // `WebSocket` exists — not only in the browser.
    const transport = createRelayTransport("http://127.0.0.1:5174");

    if (typeof WebSocket === "undefined") {
      expect(transport).toBeNull();
      return;
    }

    expect(transport).not.toBeNull();
    transport?.dispose();
  });

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
