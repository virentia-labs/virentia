import { run } from "../kernel";
import type { Node } from "../kernel";
import type { Scope } from "../scope";
import {
  annotateInspectorNode,
  annotateInspectorScope,
  enableInspector,
  getInspectorNodeById,
  getInspectorNodeId,
  getInspectorScopeById,
  getInspectorScopeId,
  getInspectorSnapshot,
  onInspectorEvent,
  readInspectorNodeMeta,
  setInspectorBreakpoints,
  type InspectorEdgeSnapshot,
  type InspectorNodeMeta,
  type InspectorNodeSnapshot,
  type InspectorScopeSnapshot,
  type InspectorSnapshot,
  registerInspectorNode,
  registerInspectorScope,
} from "../kernel/inspector";

export type DevtoolsGraphNode = InspectorNodeSnapshot;
export type DevtoolsGraphEdge = InspectorEdgeSnapshot;
export type DevtoolsScope = InspectorScopeSnapshot;
export type DevtoolsNodeMeta = InspectorNodeMeta;

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

export interface InstallVirentiaDevtoolsOptions {
  appName?: string;
  autoOpen?: boolean;
  channel?: string;
  inspectorUrl?: string;
}

export interface TriggerUnitOptions {
  nodeId: string;
  scopeId?: string | null;
  payload?: unknown;
}

export interface TriggerUnitResult {
  ok: boolean;
  error?: SerializedDevtoolsValue;
}

export interface VirentiaDevtoolsBridge {
  readonly appId: string;
  readonly channel: string;
  dispose(): void;
  open(): Window | null;
  sendGraph(): void;
  setBreakpoints(nodeIds: readonly string[]): void;
  snapshot(): DevtoolsSnapshot;
}

export interface ConnectVirentiaInspectorOptions {
  channel?: string;
}

export type VirentiaInspectorEvent =
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

export interface VirentiaInspectorClient {
  readonly channel: string;
  dispose(): void;
  requestGraph(): void;
  setBreakpoints(nodeIds: readonly string[]): void;
  subscribe(listener: (event: VirentiaInspectorEvent) => void): () => void;
  triggerUnit(options: TriggerUnitOptions): Promise<TriggerUnitResult>;
}

type AppMessage =
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

type InspectorMessage =
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

interface ProtocolEnvelope<Message> {
  __virentiaDevtools: true;
  id: string;
  channel: string;
  target: "app" | "inspector";
  message: Message;
}

type ProtocolListener<Message> = (message: Message) => void;

interface ProtocolEndpoint<Incoming, Outgoing> {
  dispose(): void;
  onMessage(listener: ProtocolListener<Incoming>): () => void;
  send(message: Outgoing): void;
}

interface RelayTransport {
  dispose(): void;
  onMessage(listener: (message: unknown) => void): () => void;
  send(message: unknown): void;
}

type UnitLike = Node | { readonly node: Node };

const defaultDevtoolsChannel = "virentia-devtools";
const defaultInspectorUrl = "http://127.0.0.1:5174";
const relayPathname = "/__virentia_devtools";

export function installVirentiaDevtools(
  options: InstallVirentiaDevtoolsOptions = {},
): VirentiaDevtoolsBridge {
  const appId = createId("app");
  const appName = options.appName ?? "Virentia app";
  const channel = options.channel ?? defaultDevtoolsChannel;
  const inspectorUrl = readConfiguredInspectorUrl(options.inspectorUrl);
  const endpoint = createAppEndpoint(channel, inspectorUrl);
  const disableInspector = enableInspector();
  let disposed = false;
  let graphQueued = false;
  let sequence = 0;

  const sendApp = (): void => {
    endpoint.send({ type: "app", appId, appName });
  };

  const sendGraph = (): void => {
    endpoint.send({ type: "graph", snapshot: getInspectorSnapshot() });
  };

  const queueGraph = (): void => {
    if (graphQueued) {
      return;
    }

    graphQueued = true;
    queueMicrotask(() => {
      graphQueued = false;

      if (!disposed) {
        sendGraph();
      }
    });
  };

  const unsubscribeInspector = onInspectorEvent((event) => {
    if (event.type === "node-created" || event.type === "scope-created") {
      queueGraph();
      return;
    }

    if (event.type === "breakpoint-hit") {
      endpoint.send({
        type: "timeline",
        event: {
          ...createTimelineEvent(++sequence, event.node, event.scope, event.payload, event.value, {
            breakpoint: true,
            duration: 0,
            failed: false,
            stopped: true,
            timestamp: event.timestamp,
          }),
        },
      });
      return;
    }

    if (event.type === "node-end") {
      endpoint.send({
        type: "timeline",
        event: createTimelineEvent(
          ++sequence,
          event.node,
          event.scope,
          event.payload,
          event.value,
          {
            breakpoint: false,
            duration: event.duration,
            failed: event.failed,
            stopped: event.stopped,
            timestamp: event.timestamp,
          },
        ),
      });
    }
  });

  const unsubscribeMessages = endpoint.onMessage((message) => {
    if (message.type === "ready") {
      sendApp();
      sendGraph();
      return;
    }

    if (message.type === "request-graph") {
      sendGraph();
      return;
    }

    if (message.type === "set-breakpoints") {
      setInspectorBreakpoints(message.nodeIds);
      sendGraph();
      return;
    }

    if (message.type === "trigger-unit") {
      void triggerUnit(message).then((result) => {
        endpoint.send({
          type: "trigger-result",
          requestId: message.requestId,
          result,
        });
      });
    }
  });

  const bridge: VirentiaDevtoolsBridge = {
    appId,
    channel,

    dispose() {
      if (disposed) {
        return;
      }

      disposed = true;
      unsubscribeMessages();
      unsubscribeInspector();
      disableInspector();
      endpoint.dispose();
    },

    open() {
      return openInspectorWindow(channel, appName, inspectorUrl);
    },

    sendGraph,

    setBreakpoints(nodeIds) {
      setInspectorBreakpoints(nodeIds);
      sendGraph();
    },

    snapshot() {
      return getInspectorSnapshot();
    },
  };

  sendApp();
  sendGraph();

  if (options.autoOpen) {
    bridge.open();
  }

  return bridge;
}

export function openVirentiaDevtools(
  options: Omit<InstallVirentiaDevtoolsOptions, "autoOpen"> = {},
): VirentiaDevtoolsBridge {
  return installVirentiaDevtools({
    ...options,
    autoOpen: true,
  });
}

export function connectVirentiaInspector(
  options: ConnectVirentiaInspectorOptions = {},
): VirentiaInspectorClient {
  const channel = options.channel ?? readChannelFromLocation();
  const endpoint = createInspectorEndpoint(channel);
  const listeners = new Set<(event: VirentiaInspectorEvent) => void>();
  const pending = new Map<string, (result: TriggerUnitResult) => void>();

  const emit = (event: VirentiaInspectorEvent): void => {
    for (const listener of listeners) {
      listener(event);
    }
  };

  endpoint.onMessage((message) => {
    if (message.type === "trigger-result") {
      pending.get(message.requestId)?.(message.result);
      pending.delete(message.requestId);
    }

    emit(message);
  });

  endpoint.send({ type: "ready" });

  return {
    channel,

    dispose() {
      endpoint.dispose();
      pending.clear();
      listeners.clear();
    },

    requestGraph() {
      endpoint.send({ type: "request-graph" });
    },

    setBreakpoints(nodeIds) {
      endpoint.send({
        type: "set-breakpoints",
        nodeIds: [...nodeIds],
      });
    },

    subscribe(listener) {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },

    triggerUnit(options) {
      const requestId = createId("trigger");

      endpoint.send({
        type: "trigger-unit",
        requestId,
        nodeId: options.nodeId,
        scopeId: options.scopeId,
        payload: options.payload,
      });

      return new Promise((resolve) => {
        pending.set(requestId, resolve);
      });
    },
  };
}

export function getVirentiaDevtoolsSnapshot(): DevtoolsSnapshot {
  enableInspector();

  return getInspectorSnapshot();
}

export function setVirentiaDevtoolsBreakpoints(nodeIds: Iterable<string>): void {
  enableInspector();
  setInspectorBreakpoints(nodeIds);
}

export function nameUnit(unit: UnitLike, name: string): void {
  const node = resolveNode(unit);
  annotateInspectorNode(node, { name });
}

export function describeUnit(unit: UnitLike, meta: InspectorNodeMeta): void {
  const node = resolveNode(unit);
  annotateInspectorNode(node, meta);
}

export function nameScope(scope: Scope, name: string): void {
  annotateInspectorScope(scope, { name });
}

export function getDevtoolsNodeId(unit: UnitLike): string {
  enableInspector();
  registerInspectorNode(resolveNode(unit));

  return getInspectorNodeId(resolveNode(unit));
}

export function getDevtoolsScopeId(scope: Scope): string {
  enableInspector();
  registerInspectorScope(scope);

  return getInspectorScopeId(scope);
}

async function triggerUnit(message: Extract<InspectorMessage, { type: "trigger-unit" }>) {
  const node = getInspectorNodeById(message.nodeId);

  if (!node) {
    return {
      ok: false,
      error: serializeDevtoolsValue(new Error(`Unknown node: ${message.nodeId}`)),
    } satisfies TriggerUnitResult;
  }

  const scope = message.scopeId ? getInspectorScopeById(message.scopeId) : null;

  if (message.scopeId && !scope) {
    return {
      ok: false,
      error: serializeDevtoolsValue(new Error(`Unknown scope: ${message.scopeId}`)),
    } satisfies TriggerUnitResult;
  }

  try {
    await run({
      unit: node,
      payload: message.payload,
      scope,
    });

    return { ok: true } satisfies TriggerUnitResult;
  } catch (error) {
    return {
      ok: false,
      error: serializeDevtoolsValue(error),
    } satisfies TriggerUnitResult;
  }
}

function createTimelineEvent(
  sequence: number,
  node: Node,
  scope: Scope | null,
  payload: unknown,
  result: unknown,
  status: {
    breakpoint: boolean;
    duration: number;
    failed: boolean;
    stopped: boolean;
    timestamp: number;
  },
): DevtoolsTimelineEvent {
  const nodeId = getInspectorNodeId(node);
  const meta = readInspectorNodeMeta(node);
  const nodeType = meta.type ?? "node";
  const scopeId = scope ? getInspectorScopeId(scope) : null;
  const scopeSnapshot = getInspectorSnapshot().scopes.find((item) => item.id === scopeId);

  return {
    id: `timeline:${sequence}`,
    sequence,
    nodeId,
    nodeName: meta.name ?? `${nodeType} ${nodeId.replace("node:", "#")}`,
    nodeType,
    scopeId,
    scopeName: scopeSnapshot?.name ?? null,
    payload: serializeDevtoolsValue(payload),
    result: serializeDevtoolsValue(result),
    failed: status.failed,
    stopped: status.stopped,
    breakpoint: status.breakpoint,
    duration: status.duration,
    timestamp: status.timestamp,
  };
}

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

function createAppEndpoint(
  channel: string,
  inspectorUrl: string,
): ProtocolEndpoint<InspectorMessage, AppMessage> {
  const listeners = new Set<ProtocolListener<InspectorMessage>>();
  const clients = new Set<Window>();
  const broadcast = createBroadcast(channel);
  const relay = createRelayTransport(inspectorUrl);
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

function createInspectorEndpoint(channel: string): ProtocolEndpoint<AppMessage, InspectorMessage> {
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

function createRelayTransport(inspectorUrl: string): RelayTransport | null {
  if (!canUseWindow() || typeof WebSocket === "undefined") {
    return null;
  }

  const relayUrl = createRelayUrl(inspectorUrl);
  const listeners = new Set<(message: unknown) => void>();
  const queue: string[] = [];
  let socket: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const emit = (message: unknown): void => {
    for (const listener of listeners) {
      listener(message);
    }
  };

  const scheduleReconnect = (): void => {
    if (disposed || reconnectTimer) {
      return;
    }

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, 1_000);
  };

  const flush = (): void => {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
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
      socket = new WebSocket(relayUrl);
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
        // Ignore invalid relay payloads. The relay is transport-only.
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

      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(payload);
        return;
      }

      queue.push(payload);

      if (queue.length > 100) {
        queue.shift();
      }
    },
  };
}

function openInspectorWindow(
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

function readChannelFromLocation(): string {
  if (!canUseWindow()) {
    return defaultDevtoolsChannel;
  }

  return new URL(window.location.href).searchParams.get("channel") ?? defaultDevtoolsChannel;
}

function readConfiguredInspectorUrl(inspectorUrl: string | undefined): string {
  return (
    inspectorUrl ??
    (globalThis as { __VIRENTIA_INSPECTOR_URL__?: string }).__VIRENTIA_INSPECTOR_URL__ ??
    defaultInspectorUrl
  );
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

function resolveNode(unit: UnitLike): Node {
  return "node" in unit ? unit.node : unit;
}

function createId(prefix: string): string {
  return `${prefix}:${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

function truncate(value: string): string {
  return value.length > 180 ? `${value.slice(0, 177)}...` : value;
}
