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
  registerInspectorNode,
  registerInspectorScope,
} from "../kernel/inspector";
import {
  createAppEndpoint,
  createId,
  createInspectorEndpoint,
  defaultDevtoolsChannel,
  openInspectorWindow,
  readChannelFromLocation,
  readConfiguredInspectorUrl,
  serializeDevtoolsValue,
  type DevtoolsSnapshot,
  type DevtoolsTimelineEvent,
  type InspectorMessage,
  type RelayTransport,
  type TriggerUnitResult,
} from "./transport";

export {
  createAppEndpoint,
  createId,
  createRelayTransport,
  createWebSocketTransport,
  defaultDevtoolsChannel,
  defaultInspectorUrl,
  openInspectorWindow,
  readConfiguredInspectorUrl,
  relayPathname,
  serializeDevtoolsValue,
} from "./transport";
export type {
  AppMessage,
  DevtoolsSnapshot,
  DevtoolsTimelineEvent,
  InspectorMessage,
  ProtocolEndpoint,
  ProtocolEnvelope,
  ProtocolListener,
  RelayTransport,
  SerializedDevtoolsValue,
  TriggerUnitResult,
  WebSocketConstructorLike,
  WebSocketLike,
  WebSocketTransportOptions,
} from "./transport";

export type DevtoolsGraphNode = InspectorNodeSnapshot;
export type DevtoolsGraphEdge = InspectorEdgeSnapshot;
export type DevtoolsScope = InspectorScopeSnapshot;
export type DevtoolsNodeMeta = InspectorNodeMeta;

export interface InstallVirentiaDevtoolsOptions {
  appName?: string;
  autoOpen?: boolean;
  channel?: string;
  inspectorUrl?: string;
  /**
   * Overrides the wire transport used to talk to the inspector.
   *
   * By default the bridge connects over a WebSocket relay (`inspectorUrl`),
   * which works both in the browser and in non-browser hosts like React
   * Native. Pass a custom {@link RelayTransport} to route devtools traffic
   * through a different channel (Metro, Flipper, a native bridge, …), or pass
   * `null` to disable the relay entirely and rely on in-page transports only.
   */
  transport?: RelayTransport | null;
}

export interface TriggerUnitOptions {
  nodeId: string;
  scopeId?: string | null;
  payload?: unknown;
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

type UnitLike = Node | { readonly node: Node };

export function installVirentiaDevtools(
  options: InstallVirentiaDevtoolsOptions = {},
): VirentiaDevtoolsBridge {
  const appId = createId("app");
  const appName = options.appName ?? "Virentia app";
  const channel = options.channel ?? defaultDevtoolsChannel;
  const inspectorUrl = readConfiguredInspectorUrl(options.inspectorUrl);
  const endpoint = createAppEndpoint(channel, inspectorUrl, options.transport);
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

function resolveNode(unit: UnitLike): Node {
  return "node" in unit ? unit.node : unit;
}
