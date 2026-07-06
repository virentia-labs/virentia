import type { InspectorSnapshot } from "../kernel/inspector";

export interface DevtoolsSnapshot extends InspectorSnapshot {}

export interface SerializedDevtoolsValue {
  kind: string;
  preview: string;
  value?: unknown;
}

export interface DevtoolsTimelineEvent {
  id: string;
  sequence: number;
  nodeId: string;
  nodeName: string;
  nodeType: string;
  scopeId: string | null;
  scopeName: string | null;
  payload: SerializedDevtoolsValue;
  result: SerializedDevtoolsValue;
  failed: boolean;
  stopped: boolean;
  breakpoint: boolean;
  duration: number;
  timestamp: number;
}

export interface TriggerUnitResult {
  ok: boolean;
  error?: SerializedDevtoolsValue;
}

export type AppMessage =
  | {
      type: "app";
      appId: string;
      appName: string;
    }
  | {
      type: "graph";
      snapshot: DevtoolsSnapshot;
    }
  | {
      type: "timeline";
      event: DevtoolsTimelineEvent;
    }
  | {
      type: "trigger-result";
      requestId: string;
      result: TriggerUnitResult;
    };

export type InspectorMessage =
  | {
      type: "ready";
    }
  | {
      type: "request-graph";
    }
  | {
      type: "set-breakpoints";
      nodeIds: string[];
    }
  | {
      type: "trigger-unit";
      requestId: string;
      nodeId: string;
      scopeId?: string | null;
      payload?: unknown;
    };

export interface ProtocolEnvelope<Message> {
  __virentiaDevtools: true;
  id: string;
  channel: string;
  target: "app" | "inspector";
  message: Message;
}

export type ProtocolListener<Message> = (message: Message) => void;

export interface ProtocolEndpoint<Incoming, Outgoing> {
  dispose(): void;
  onMessage(listener: ProtocolListener<Incoming>): () => void;
  send(message: Outgoing): void;
}

export interface RelayTransport {
  dispose(): void;
  onMessage(listener: (message: unknown) => void): () => void;
  send(message: unknown): void;
}

export const defaultDevtoolsChannel = "virentia-devtools";
export const defaultInspectorUrl = "http://127.0.0.1:5174";
export const relayPathname = "/__virentia_devtools";

export function serializeDevtoolsValue(value: unknown): SerializedDevtoolsValue {
  const seen = new WeakSet<object>();

  return serialize(value, 0);

  function serialize(input: unknown, depth: number): SerializedDevtoolsValue {
    if (input === undefined) {
      return { kind: "undefined", preview: "undefined" };
    }

    if (input === null) {
      return { kind: "null", preview: "null", value: null };
    }

    if (typeof input === "string") {
      return { kind: "string", preview: truncate(JSON.stringify(input)), value: input };
    }

    if (typeof input === "number" || typeof input === "boolean") {
      return { kind: typeof input, preview: String(input), value: input };
    }

    if (typeof input === "bigint") {
      return { kind: "bigint", preview: `${input}n` };
    }

    if (typeof input === "symbol") {
      return { kind: "symbol", preview: String(input) };
    }

    if (typeof input === "function") {
      return { kind: "function", preview: `[Function ${input.name || "anonymous"}]` };
    }

    if (input instanceof Error) {
      return {
        kind: "error",
        preview: `${input.name}: ${input.message}`,
        value: {
          name: input.name,
          message: input.message,
        },
      };
    }

    if (typeof input !== "object") {
      return { kind: typeof input, preview: String(input) };
    }

    if (seen.has(input)) {
      return { kind: "circular", preview: "[Circular]" };
    }

    seen.add(input);

    if (Array.isArray(input)) {
      const items =
        depth >= 2 ? [] : input.slice(0, 8).map((item) => serialize(item, depth + 1).value);

      return {
        kind: "array",
        preview: truncate(
          `[${input
            .slice(0, 5)
            .map((item) => serialize(item, depth + 1).preview)
            .join(", ")}${input.length > 5 ? ", ..." : ""}]`,
        ),
        value: items,
      };
    }

    const entries = Object.entries(input as Record<string, unknown>);
    const preview = `{${entries
      .slice(0, 5)
      .map(([key, item]) => `${key}: ${serialize(item, depth + 1).preview}`)
      .join(", ")}${entries.length > 5 ? ", ..." : ""}}`;
    const value =
      depth >= 2
        ? undefined
        : Object.fromEntries(
            entries.slice(0, 12).map(([key, item]) => [key, serialize(item, depth + 1).value]),
          );

    return {
      kind: "object",
      preview: truncate(preview),
      value,
    };
  }
}

export function createAppEndpoint(
  channel: string,
  inspectorUrl: string,
  customTransport?: RelayTransport | null,
): ProtocolEndpoint<InspectorMessage, AppMessage> {
  const listeners = new Set<ProtocolListener<InspectorMessage>>();
  const clients = new Set<Window>();
  const broadcast = createBroadcast(channel);
  const relay =
    customTransport === undefined ? createRelayTransport(inspectorUrl) : customTransport;
  const seenMessages = createSeenMessages();
  const onWindowMessage = (event: MessageEvent) => {
    const envelope = readEnvelope<InspectorMessage>(event.data, channel, "app");

    if (!envelope) {
      return;
    }

    if (isWindow(event.source)) {
      clients.add(event.source);
    }

    emitEnvelope(envelope);
  };
  const onBroadcastMessage = (event: MessageEvent) => {
    const envelope = readEnvelope<InspectorMessage>(event.data, channel, "app");

    if (envelope) {
      emitEnvelope(envelope);
    }
  };
  const onRelayMessage = (value: unknown) => {
    const envelope = readEnvelope<InspectorMessage>(value, channel, "app");

    if (envelope) {
      emitEnvelope(envelope);
    }
  };
  const emit = (message: InspectorMessage): void => {
    for (const listener of listeners) {
      listener(message);
    }
  };
  const emitEnvelope = (envelope: ProtocolEnvelope<InspectorMessage>): void => {
    if (seenMessages.has(envelope)) {
      return;
    }

    emit(envelope.message);
  };

  if (canUseWindow()) {
    window.addEventListener("message", onWindowMessage);
  }

  if (broadcast) {
    broadcast.addEventListener("message", onBroadcastMessage);
  }

  const unsubscribeRelay = relay?.onMessage(onRelayMessage);

  return {
    dispose() {
      if (canUseWindow()) {
        window.removeEventListener("message", onWindowMessage);
      }

      broadcast?.removeEventListener("message", onBroadcastMessage);
      broadcast?.close();
      unsubscribeRelay?.();
      relay?.dispose();
      listeners.clear();
      clients.clear();
    },

    onMessage(listener) {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },

    send(message) {
      const envelope = createEnvelope(channel, "inspector", message);

      for (const client of clients) {
        client.postMessage(envelope, "*");
      }

      broadcast?.postMessage(envelope);
      relay?.send(envelope);
    },
  };
}

export function createInspectorEndpoint(
  channel: string,
): ProtocolEndpoint<AppMessage, InspectorMessage> {
  const listeners = new Set<ProtocolListener<AppMessage>>();
  const apps = new Set<Window>();
  const broadcast = createBroadcast(channel);
  const relay = createRelayTransport(readInspectorUrlFromLocation());
  const seenMessages = createSeenMessages();
  const onWindowMessage = (event: MessageEvent) => {
    const envelope = readEnvelope<AppMessage>(event.data, channel, "inspector");

    if (!envelope) {
      return;
    }

    if (isWindow(event.source)) {
      apps.add(event.source);
    }

    emitEnvelope(envelope);
  };
  const onBroadcastMessage = (event: MessageEvent) => {
    const envelope = readEnvelope<AppMessage>(event.data, channel, "inspector");

    if (envelope) {
      emitEnvelope(envelope);
    }
  };
  const onRelayMessage = (value: unknown) => {
    const envelope = readEnvelope<AppMessage>(value, channel, "inspector");

    if (envelope) {
      emitEnvelope(envelope);
    }
  };
  const emit = (message: AppMessage): void => {
    for (const listener of listeners) {
      listener(message);
    }
  };
  const emitEnvelope = (envelope: ProtocolEnvelope<AppMessage>): void => {
    if (seenMessages.has(envelope)) {
      return;
    }

    emit(envelope.message);
  };

  if (canUseWindow()) {
    window.addEventListener("message", onWindowMessage);

    if (window.opener) {
      apps.add(window.opener);
    }
  }

  if (broadcast) {
    broadcast.addEventListener("message", onBroadcastMessage);
  }

  const unsubscribeRelay = relay?.onMessage(onRelayMessage);

  return {
    dispose() {
      if (canUseWindow()) {
        window.removeEventListener("message", onWindowMessage);
      }

      broadcast?.removeEventListener("message", onBroadcastMessage);
      broadcast?.close();
      unsubscribeRelay?.();
      relay?.dispose();
      listeners.clear();
      apps.clear();
    },

    onMessage(listener) {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },

    send(message) {
      const envelope = createEnvelope(channel, "app", message);

      for (const app of apps) {
        app.postMessage(envelope, "*");
      }

      broadcast?.postMessage(envelope);
      relay?.send(envelope);
    },
  };
}

export function openInspectorWindow(
  channel: string,
  appName: string,
  inspectorUrl: string,
): Window | null {
  if (!canUseWindow()) {
    return null;
  }

  const url = new URL(inspectorUrl, window.location.href);

  url.searchParams.set("channel", channel);
  url.searchParams.set("appName", appName);

  return window.open(url.toString(), `virentia-devtools:${channel}`);
}

export function readChannelFromLocation(): string {
  if (!canUseWindow()) {
    return defaultDevtoolsChannel;
  }

  return new URL(window.location.href).searchParams.get("channel") ?? defaultDevtoolsChannel;
}

export function readConfiguredInspectorUrl(inspectorUrl: string | undefined): string {
  return (
    inspectorUrl ??
    (globalThis as { __VIRENTIA_INSPECTOR_URL__?: string }).__VIRENTIA_INSPECTOR_URL__ ??
    defaultInspectorUrl
  );
}

export function createId(prefix: string): string {
  return `${prefix}:${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

/** Minimal WHATWG `WebSocket` surface the transport relies on. */
export interface WebSocketLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void;
}

export type WebSocketConstructorLike = new (url: string) => WebSocketLike;

export interface WebSocketTransportOptions {
  /**
   * WebSocket implementation to use. Defaults to the global `WebSocket`, which
   * exists in browsers, React Native, Web Workers, Node 22+, Deno and Bun. In an
   * environment without one, pass a WHATWG-compatible constructor — e.g. the
   * `ws` package (`{ webSocket: WebSocket }` from `import { WebSocket } from "ws"`).
   */
  webSocket?: WebSocketConstructorLike;
  /** Delay in ms before reconnecting after the socket drops. Default 1000. `0` disables reconnect. */
  reconnectDelay?: number;
  /** Max messages buffered while disconnected (oldest dropped past this). Default 100. */
  maxQueue?: number;
}

// The WHATWG `WebSocket.OPEN` ready state. Hard-coded so we do not depend on a
// global `WebSocket` being present to read the constant off it.
const webSocketOpen = 1;

/**
 * A ready-made {@link RelayTransport} over a WebSocket, usable in any JS runtime
 * with a WHATWG `WebSocket` (or an injected one). It reconnects automatically and
 * buffers messages while disconnected. Pass it as `installVirentiaDevtools({
 * transport })`.
 *
 * `url` is the full WebSocket URL of a relay both ends connect to (the built-in
 * `virentia-inspector` relay listens on the `/__virentia_devtools` path, e.g.
 * `ws://192.168.1.5:5174/__virentia_devtools`).
 */
export function createWebSocketTransport(
  url: string,
  options: WebSocketTransportOptions = {},
): RelayTransport {
  const WebSocketImpl =
    options.webSocket ??
    (typeof WebSocket === "undefined"
      ? undefined
      : (WebSocket as unknown as WebSocketConstructorLike));

  if (!WebSocketImpl) {
    throw new Error(
      "[virentia] createWebSocketTransport: no WebSocket implementation available. " +
        "Pass options.webSocket (e.g. the `ws` package) in environments without a global WebSocket.",
    );
  }

  const reconnectDelay = options.reconnectDelay ?? 1_000;
  const maxQueue = options.maxQueue ?? 100;
  const listeners = new Set<(message: unknown) => void>();
  const queue: string[] = [];
  let socket: WebSocketLike | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const emit = (message: unknown): void => {
    for (const listener of listeners) {
      listener(message);
    }
  };

  const scheduleReconnect = (): void => {
    if (disposed || reconnectTimer || reconnectDelay <= 0) {
      return;
    }

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, reconnectDelay);
  };

  const flush = (): void => {
    if (!socket || socket.readyState !== webSocketOpen) {
      return;
    }

    while (queue.length) {
      socket.send(queue.shift() as string);
    }
  };

  const connect = (): void => {
    if (disposed) {
      return;
    }

    try {
      socket = new WebSocketImpl(url);
    } catch {
      scheduleReconnect();
      return;
    }

    socket.addEventListener("open", flush);
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") {
        return;
      }

      try {
        emit(JSON.parse(event.data) as unknown);
      } catch {
        // Ignore invalid payloads. The transport carries JSON envelopes only.
      }
    });
    socket.addEventListener("close", () => {
      socket = null;
      scheduleReconnect();
    });
    socket.addEventListener("error", () => {
      socket?.close();
    });
  };

  connect();

  return {
    dispose() {
      disposed = true;

      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
      }

      socket?.close();
      socket = null;
      queue.length = 0;
      listeners.clear();
    },

    onMessage(listener) {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },

    send(message) {
      const payload = JSON.stringify(message);

      if (socket?.readyState === webSocketOpen) {
        socket.send(payload);
        return;
      }

      queue.push(payload);

      if (queue.length > maxQueue) {
        queue.shift();
      }
    },
  };
}

export function createRelayTransport(inspectorUrl: string): RelayTransport | null {
  // The relay is just a WebSocket client to the inspector's relay path. It is
  // deliberately NOT gated behind `window`: outside the browser (React Native,
  // workers, Node) it is the only transport, so gating it there would leave those
  // hosts unable to reach the inspector at all.
  if (typeof WebSocket === "undefined") {
    return null;
  }

  return createWebSocketTransport(createRelayUrl(inspectorUrl));
}

function readInspectorUrlFromLocation(): string {
  return canUseWindow() ? window.location.href : defaultInspectorUrl;
}

function createRelayUrl(inspectorUrl: string): string {
  const url = new URL(inspectorUrl, canUseWindow() ? window.location.href : defaultInspectorUrl);

  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = relayPathname;
  url.search = "";
  url.hash = "";

  return url.toString();
}

function createBroadcast(channel: string): BroadcastChannel | null {
  if (typeof BroadcastChannel === "undefined") {
    return null;
  }

  try {
    return new BroadcastChannel(`virentia-devtools:${channel}`);
  } catch {
    return null;
  }
}

function createEnvelope<Message>(
  channel: string,
  target: ProtocolEnvelope<Message>["target"],
  message: Message,
): ProtocolEnvelope<Message> {
  return {
    __virentiaDevtools: true,
    id: createId("message"),
    channel,
    target,
    message,
  };
}

function readEnvelope<Message>(
  value: unknown,
  channel: string,
  target: ProtocolEnvelope<Message>["target"],
): ProtocolEnvelope<Message> | null {
  if (
    !value ||
    typeof value !== "object" ||
    (value as ProtocolEnvelope<Message>).__virentiaDevtools !== true ||
    (value as ProtocolEnvelope<Message>).channel !== channel ||
    (value as ProtocolEnvelope<Message>).target !== target
  ) {
    return null;
  }

  return value as ProtocolEnvelope<Message>;
}

function createSeenMessages(): { has(envelope: ProtocolEnvelope<unknown>): boolean } {
  const seen = new Set<string>();
  const order: string[] = [];

  return {
    has(envelope) {
      if (seen.has(envelope.id)) {
        return true;
      }

      seen.add(envelope.id);
      order.push(envelope.id);

      if (order.length > 1_000) {
        const oldest = order.shift();

        if (oldest) {
          seen.delete(oldest);
        }
      }

      return false;
    },
  };
}

function isWindow(value: unknown): value is Window {
  return Boolean(value && typeof (value as Window).postMessage === "function");
}

function canUseWindow(): boolean {
  return typeof window !== "undefined";
}

function truncate(value: string): string {
  return value.length > 180 ? `${value.slice(0, 177)}...` : value;
}
