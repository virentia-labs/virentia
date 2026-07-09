import { afterEach, describe, expect, it, vi } from "vitest";
import { store } from "../../lib";
import { node } from "../../lib/internal";
import { setInspectorBreakpoints } from "../../lib/kernel/inspector";
import {
  connectVirentiaInspector,
  createAppEndpoint,
  createRelayTransport,
  createWebSocketTransport,
  defaultInspectorUrl,
  getDevtoolsNodeId,
  installVirentiaDevtools,
  nameUnit,
  relayPathname,
  serializeDevtoolsValue,
  type InspectorMessage,
  type RelayTransport,
  type WebSocketConstructorLike,
} from "../../lib/devtools";
import {
  inboundEnvelope,
  makeFakeCtor,
  recordingTransport,
} from "../support/devtools-transport";
import { macrotask, uniqueChannel, uniqueName, waitUntil } from "../support/devtools-harness";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  // The kernel breakpoint set is process-global; clear it so a stray breakpoint
  // from one test cannot stop chains in another.
  setInspectorBreakpoints([]);
});

describe("createWebSocketTransport", () => {
  it("throws a descriptive error when no WebSocket is available", () => {
    vi.stubGlobal("WebSocket", undefined);

    expect(() => createWebSocketTransport("ws://x/__virentia_devtools")).toThrowError(
      /createWebSocketTransport[\s\S]*options\.webSocket/,
    );
  });

  it("prefers the injected webSocket over the global one", () => {
    vi.stubGlobal(
      "WebSocket",
      function () {
        throw new Error("global WebSocket must not be used");
      },
    );
    const fake = makeFakeCtor();

    let transport: RelayTransport | undefined;
    expect(() => {
      transport = createWebSocketTransport("ws://x/__virentia_devtools", { webSocket: fake.ctor });
    }).not.toThrow();

    expect(fake.instances).toHaveLength(1);
    expect(fake.instances[0]!.url).toBe("ws://x/__virentia_devtools");
    transport!.dispose();
  });

  it("buffers sends until the socket opens, then flushes them in FIFO order", () => {
    const fake = makeFakeCtor();
    const transport = createWebSocketTransport("ws://x", {
      webSocket: fake.ctor,
      reconnectDelay: 0,
    });
    const socket = fake.instances[0]!;

    transport.send({ n: 1 });
    transport.send({ n: 2 });
    expect(socket.sent).toEqual([]);

    socket.open();
    expect(socket.sent).toEqual([JSON.stringify({ n: 1 }), JSON.stringify({ n: 2 })]);

    transport.send({ n: 3 });
    expect(socket.sent).toEqual([
      JSON.stringify({ n: 1 }),
      JSON.stringify({ n: 2 }),
      JSON.stringify({ n: 3 }),
    ]);

    transport.dispose();
  });

  it("drops the oldest queued send once the queue reaches maxQueue", () => {
    const fake = makeFakeCtor();
    const transport = createWebSocketTransport("ws://x", {
      webSocket: fake.ctor,
      reconnectDelay: 0,
      maxQueue: 2,
    });
    const socket = fake.instances[0]!;

    transport.send({ n: 1 });
    transport.send({ n: 2 });
    transport.send({ n: 3 });
    transport.send({ n: 4 });

    socket.open();

    expect(socket.sent).toEqual([JSON.stringify({ n: 3 }), JSON.stringify({ n: 4 })]);

    transport.dispose();
  });

  it("drops every buffered send when maxQueue is zero", () => {
    const fake = makeFakeCtor();
    const transport = createWebSocketTransport("ws://x", {
      webSocket: fake.ctor,
      reconnectDelay: 0,
      maxQueue: 0,
    });
    const socket = fake.instances[0]!;

    transport.send({ n: 1 });
    transport.send({ n: 2 });
    transport.send({ n: 3 });

    socket.open();
    expect(socket.sent).toEqual([]);

    transport.dispose();
  });

  it("defaults maxQueue to one hundred", () => {
    const fake = makeFakeCtor();
    const transport = createWebSocketTransport("ws://x", {
      webSocket: fake.ctor,
      reconnectDelay: 0,
    });
    const socket = fake.instances[0]!;

    for (let i = 0; i <= 100; i++) {
      transport.send({ n: i });
    }

    socket.open();

    expect(socket.sent).toHaveLength(100);
    expect(socket.sent[0]).toBe(JSON.stringify({ n: 1 }));
    expect(socket.sent[99]).toBe(JSON.stringify({ n: 100 }));

    transport.dispose();
  });

  it("ignores incoming messages that are non-string or unparseable", () => {
    const fake = makeFakeCtor();
    const transport = createWebSocketTransport("ws://x", {
      webSocket: fake.ctor,
      reconnectDelay: 0,
    });
    const socket = fake.instances[0]!;
    const received: unknown[] = [];
    transport.onMessage((message) => received.push(message));

    socket.fire("message", { data: 42 });
    socket.fire("message", { data: "{oops" });
    socket.fire("message", { data: JSON.stringify({ ok: 1 }) });

    expect(received).toEqual([{ ok: 1 }]);

    transport.dispose();
  });

  it("stops delivering to a listener that unsubscribes while still fanning out to the others", () => {
    const fake = makeFakeCtor();
    const transport = createWebSocketTransport("ws://x", {
      webSocket: fake.ctor,
      reconnectDelay: 0,
    });
    const socket = fake.instances[0]!;
    const a: unknown[] = [];
    const b: unknown[] = [];
    const unsubscribeA = transport.onMessage((message) => a.push(message));
    transport.onMessage((message) => b.push(message));

    socket.fire("message", { data: JSON.stringify({ v: 1 }) });
    expect(a).toEqual([{ v: 1 }]);
    expect(b).toEqual([{ v: 1 }]);

    unsubscribeA();
    socket.fire("message", { data: JSON.stringify({ v: 2 }) });
    expect(a).toEqual([{ v: 1 }]);
    expect(b).toEqual([{ v: 1 }, { v: 2 }]);

    transport.dispose();
  });

  it("reconnects after the delay, replaying whatever was buffered while the socket was down", () => {
    vi.useFakeTimers();
    const fake = makeFakeCtor();
    const transport = createWebSocketTransport("ws://x", {
      webSocket: fake.ctor,
      reconnectDelay: 500,
    });

    const first = fake.instances[0]!;
    first.open();
    transport.send({ live: 1 });
    expect(first.sent).toEqual([JSON.stringify({ live: 1 })]);

    // Socket drops.
    first.fire("close");
    // With the socket cleared, sends buffer instead of writing to the dead socket.
    transport.send({ buffered: 1 });
    expect(first.sent).toEqual([JSON.stringify({ live: 1 })]);

    vi.advanceTimersByTime(500);
    expect(fake.instances).toHaveLength(2);
    const second = fake.instances[1]!;
    expect(second).not.toBe(first);

    second.open();
    expect(second.sent).toEqual([JSON.stringify({ buffered: 1 })]);

    transport.dispose();
  });

  it("defaults reconnectDelay to one thousand milliseconds", () => {
    vi.useFakeTimers();
    const fake = makeFakeCtor();
    const transport = createWebSocketTransport("ws://x", { webSocket: fake.ctor });

    fake.instances[0]!.open();
    fake.instances[0]!.fire("close");

    vi.advanceTimersByTime(999);
    expect(fake.instances).toHaveLength(1);

    vi.advanceTimersByTime(1);
    expect(fake.instances).toHaveLength(2);

    transport.dispose();
  });

  it("coalesces repeated close events into a single reconnect timer", () => {
    vi.useFakeTimers();
    const fake = makeFakeCtor();
    const transport = createWebSocketTransport("ws://x", {
      webSocket: fake.ctor,
      reconnectDelay: 500,
    });

    const first = fake.instances[0]!;
    first.open();
    // Two close events before the timer fires.
    first.fire("close");
    first.fire("close");

    vi.advanceTimersByTime(500);
    // Only one reconnect socket, not two.
    expect(fake.instances).toHaveLength(2);

    transport.dispose();
  });

  it("recovers from a throwing constructor by scheduling a reconnect", () => {
    vi.useFakeTimers();
    const fake = makeFakeCtor({ throwTimes: 1 });

    let transport: RelayTransport | undefined;
    expect(() => {
      transport = createWebSocketTransport("ws://x", {
        webSocket: fake.ctor,
        reconnectDelay: 500,
      });
    }).not.toThrow();

    // First construction threw -> no live socket yet.
    expect(fake.instances).toHaveLength(0);
    expect(fake.state.constructs).toBe(1);

    vi.advanceTimersByTime(500);
    expect(fake.instances).toHaveLength(1);

    transport!.dispose();
  });

  it("closes the socket when an error event fires", () => {
    vi.useFakeTimers();
    const fake = makeFakeCtor();
    const transport = createWebSocketTransport("ws://x", {
      webSocket: fake.ctor,
      reconnectDelay: 500,
    });
    const socket = fake.instances[0]!;
    socket.open();

    socket.fire("error");
    expect(socket.closeCalls).toBe(1);
    expect(socket.readyState).toBe(3);

    // The close event that follows drives a reconnect.
    socket.fire("close");
    vi.advanceTimersByTime(500);
    expect(fake.instances).toHaveLength(2);

    transport.dispose();
  });

  it("disables reconnect entirely when reconnectDelay is zero or less", () => {
    vi.useFakeTimers();
    const fake = makeFakeCtor();
    const transport = createWebSocketTransport("ws://x", {
      webSocket: fake.ctor,
      reconnectDelay: 0,
    });

    fake.instances[0]!.open();
    fake.instances[0]!.fire("close");

    vi.advanceTimersByTime(100000);
    vi.runOnlyPendingTimers();
    expect(fake.instances).toHaveLength(1);

    transport.dispose();
  });

  it("suppresses reconnect after dispose even when a stale close or error fires", () => {
    vi.useFakeTimers();
    const fake = makeFakeCtor();
    const transport = createWebSocketTransport("ws://x", {
      webSocket: fake.ctor,
      reconnectDelay: 500,
    });
    const socket = fake.instances[0]!;
    socket.open();

    transport.dispose();
    expect(socket.closeCalls).toBe(1);

    // Stale events arriving after disposal must not resurrect the transport.
    socket.fire("close");
    socket.fire("error");
    vi.advanceTimersByTime(100000);

    expect(fake.instances).toHaveLength(1);
  });

  // A superseded socket's late `close` no longer nulls the live socket (the close
  // handler now guards on socket identity), so a send after it still reaches the
  // live socket instead of being silently buffered.
  it("keeps sending to the live socket after a superseded socket closes", () => {
    vi.useFakeTimers();
    const fake = makeFakeCtor();
    const transport = createWebSocketTransport("ws://x", {
      webSocket: fake.ctor,
      reconnectDelay: 500,
    });

    const first = fake.instances[0]!;
    first.open();
    first.fire("close");
    vi.advanceTimersByTime(500);

    const second = fake.instances[1]!;
    second.open();
    transport.send({ x: 1 });
    expect(second.sent).toEqual([JSON.stringify({ x: 1 })]);

    first.fire("close");

    transport.send({ x: 2 });
    // {x:2} reaches the live socket rather than being buffered.
    expect(second.sent).toEqual([JSON.stringify({ x: 1 }), JSON.stringify({ x: 2 })]);

    transport.dispose();
  });

  it("tears down the queue, socket, and listeners on dispose", () => {
    const fake = makeFakeCtor();
    const transport = createWebSocketTransport("ws://x", {
      webSocket: fake.ctor,
      reconnectDelay: 0,
    });
    const socket = fake.instances[0]!;
    const received: unknown[] = [];
    transport.onMessage((message) => received.push(message));

    transport.send({ n: 1 });
    transport.send({ n: 2 });
    transport.send({ n: 3 });

    transport.dispose();
    expect(socket.closeCalls).toBe(1);
    expect(socket.readyState).toBe(3);

    // A late open finds an empty queue.
    socket.readyState = 1;
    socket.fire("open");
    expect(socket.sent).toEqual([]);

    // Listeners were cleared.
    socket.fire("message", { data: JSON.stringify({ v: 1 }) });
    expect(received).toEqual([]);
  });

  it("accepts a minimal fake WebSocket constructor", () => {
    class Minimal {
      readyState = 0;
      constructor(public url: string) {}
      send(_data: string): void {}
      close(): void {}
      addEventListener(_type: string, _listener: (event: { data?: unknown }) => void): void {}
    }

    const transport = createWebSocketTransport("ws://x", {
      webSocket: Minimal as unknown as WebSocketConstructorLike,
      reconnectDelay: 0,
    });
    expect(transport).toBeDefined();
    transport.dispose();
  });
});

describe("createRelayTransport", () => {
  it("rewrites an https inspector URL to a wss relay path", () => {
    const fake = makeFakeCtor();
    vi.stubGlobal("WebSocket", fake.ctor);

    const transport = createRelayTransport("https://host:5174/dash?q=1#frag");

    expect(fake.instances).toHaveLength(1);
    expect(fake.instances[0]!.url).toBe(`wss://host:5174${relayPathname}`);
    transport?.dispose();
  });

  it("rewrites an http inspector URL to a ws relay path", () => {
    const fake = makeFakeCtor();
    vi.stubGlobal("WebSocket", fake.ctor);

    const transport = createRelayTransport("http://127.0.0.1:5174");

    expect(fake.instances[0]!.url).toBe(`ws://127.0.0.1:5174${relayPathname}`);
    transport?.dispose();
  });

  it("returns null when WebSocket is unavailable", () => {
    vi.stubGlobal("WebSocket", undefined);

    expect(createRelayTransport("http://127.0.0.1:5174")).toBeNull();
  });
});

describe("createAppEndpoint", () => {
  it("emits a duplicated envelope id only once", () => {
    const channel = uniqueChannel();
    const transport = recordingTransport();
    const endpoint = createAppEndpoint(channel, defaultInspectorUrl, transport);
    const received: InspectorMessage[] = [];
    endpoint.onMessage((message) => received.push(message));

    const envelope = inboundEnvelope(channel, { type: "ready" }, "dup-id");
    transport.deliver(envelope);
    transport.deliver(envelope);

    expect(received).toHaveLength(1);

    endpoint.dispose();
  });

  it("evicts the oldest id after one thousand entries", () => {
    const channel = uniqueChannel();
    const transport = recordingTransport();
    const endpoint = createAppEndpoint(channel, defaultInspectorUrl, transport);
    let count = 0;
    endpoint.onMessage(() => count++);

    for (let i = 0; i <= 1000; i++) {
      transport.deliver(inboundEnvelope(channel, { type: "request-graph" }, `id-${i}`));
    }
    expect(count).toBe(1001);

    // id-0 was evicted once history exceeded 1000, so it is seen as new again.
    transport.deliver(inboundEnvelope(channel, { type: "request-graph" }, "id-0"));
    expect(count).toBe(1002);

    endpoint.dispose();
  });

  it("rejects envelopes with a bad marker, channel, or target", () => {
    const channel = uniqueChannel();
    const transport = recordingTransport();
    const endpoint = createAppEndpoint(channel, defaultInspectorUrl, transport);
    const received: InspectorMessage[] = [];
    endpoint.onMessage((message) => received.push(message));

    transport.deliver({});
    transport.deliver({ __virentiaDevtools: true, id: "m1", channel: "other", target: "app", message: { type: "ready" } });
    transport.deliver({ __virentiaDevtools: true, id: "m2", channel, target: "inspector", message: { type: "ready" } });
    transport.deliver({ id: "m3", channel, target: "app", message: { type: "ready" } });

    expect(received).toHaveLength(0);

    // A well-formed one still gets through.
    transport.deliver(inboundEnvelope(channel, { type: "ready" }, "ok"));
    expect(received).toHaveLength(1);

    endpoint.dispose();
  });

  it("constructs a relay only when customTransport is omitted, not when it is null", () => {
    const fake = makeFakeCtor();
    vi.stubGlobal("WebSocket", fake.ctor);

    const withNull = createAppEndpoint(uniqueChannel(), defaultInspectorUrl, null);
    expect(fake.state.constructs).toBe(0);
    withNull.dispose();

    const withRelay = createAppEndpoint(uniqueChannel(), defaultInspectorUrl);
    expect(fake.state.constructs).toBe(1);
    withRelay.dispose();
  });
});

describe("connectVirentiaInspector", () => {
  it("sends a ready message immediately on connect", async () => {
    const channel = uniqueChannel();
    const appSide = createAppEndpoint(channel, defaultInspectorUrl, null);
    const received: InspectorMessage[] = [];
    appSide.onMessage((message) => received.push(message));

    const inspector = connectVirentiaInspector({ channel });

    await waitUntil(() => received.some((message) => message.type === "ready"));
    expect(received.some((message) => message.type === "ready")).toBe(true);

    inspector.dispose();
    appSide.dispose();
  });

  it("resolves concurrent triggerUnit calls by requestId regardless of reply order", async () => {
    const channel = uniqueChannel();
    const appSide = createAppEndpoint(channel, defaultInspectorUrl, null);
    const requests: Array<Extract<InspectorMessage, { type: "trigger-unit" }>> = [];
    appSide.onMessage((message) => {
      if (message.type === "trigger-unit") {
        requests.push(message);
      }
    });

    const inspector = connectVirentiaInspector({ channel });
    const p1 = inspector.triggerUnit({ nodeId: "node:one" });
    const p2 = inspector.triggerUnit({ nodeId: "node:two" });

    await waitUntil(() => requests.length >= 2);
    const [first, second] = requests;

    // Reply in reversed order.
    appSide.send({ type: "trigger-result", requestId: second!.requestId, result: { ok: true } });
    appSide.send({
      type: "trigger-result",
      requestId: first!.requestId,
      result: { ok: false, error: serializeDevtoolsValue(new Error("nope")) },
    });

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.ok).toBe(false);
    expect(r2.ok).toBe(true);

    inspector.dispose();
    appSide.dispose();
  });

  it("copies the breakpoint iterable so a later mutation does not leak", async () => {
    const channel = uniqueChannel();
    const appSide = createAppEndpoint(channel, defaultInspectorUrl, null);
    const seen: string[][] = [];
    appSide.onMessage((message) => {
      if (message.type === "set-breakpoints") {
        seen.push(message.nodeIds);
      }
    });

    const inspector = connectVirentiaInspector({ channel });
    const ids = ["node:1"];
    inspector.setBreakpoints(ids);
    ids.push("node:2"); // later mutation of the source must not leak into the message

    await waitUntil(() => seen.length > 0);
    expect(seen[0]).toEqual(["node:1"]);

    inspector.dispose();
    appSide.dispose();
  });

  it("leaves an in-flight triggerUnit promise unresolved after dispose", async () => {
    const channel = uniqueChannel();
    const inspector = connectVirentiaInspector({ channel });

    let settled = false;
    const pending = inspector.triggerUnit({ nodeId: "node:x" });
    void pending.then(() => {
      settled = true;
    });

    inspector.dispose();

    const outcome = await Promise.race([
      pending.then(() => "settled" as const),
      macrotask().then(() => "timeout" as const),
    ]);

    expect(outcome).toBe("timeout");
    expect(settled).toBe(false);
  });

  it("emits every inbound message to subscribers, including trigger-result", async () => {
    const channel = uniqueChannel();
    const appSide = createAppEndpoint(channel, defaultInspectorUrl, null);
    appSide.onMessage((message) => {
      if (message.type === "trigger-unit") {
        appSide.send({ type: "trigger-result", requestId: message.requestId, result: { ok: true } });
      }
    });

    const inspector = connectVirentiaInspector({ channel });
    const events: string[] = [];
    inspector.subscribe((event) => events.push(event.type));

    await inspector.triggerUnit({ nodeId: "node:y" });
    await waitUntil(() => events.includes("trigger-result"));

    expect(events).toContain("trigger-result");

    inspector.dispose();
    appSide.dispose();
  });

  it("round-trips a triggerUnit through the app bridge over BroadcastChannel", async () => {
    const channel = uniqueChannel();
    const ran: number[] = [];
    const unit = node({
      run(ctx) {
        ran.push(ctx.value as number);
        return ctx.value;
      },
    });
    const nodeId = getDevtoolsNodeId(unit);

    const bridge = installVirentiaDevtools({ channel, transport: null });
    const inspector = connectVirentiaInspector({ channel });

    const result = await inspector.triggerUnit({ nodeId, payload: 11 });
    expect(result).toEqual({ ok: true });
    expect(ran).toEqual([11]);

    inspector.dispose();
    bridge.dispose();
  });
});

describe("nameUnit", () => {
  it("accepts both a raw node and a { node } wrapper", () => {
    const s = store(0);
    expect(() => {
      nameUnit(s, uniqueName("wrapper"));
      nameUnit(s.node, uniqueName("raw"));
    }).not.toThrow();
  });
});
