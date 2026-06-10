import {
  createAppEndpoint,
  createId,
  defaultDevtoolsChannel,
  openInspectorWindow,
  readConfiguredInspectorUrl,
  type DevtoolsSnapshot,
} from "@virentia/core/devtools";
import type { Scope, Unit } from "effector";
import { createEffectorGraph } from "./graph";
import { createEffectorTimeline } from "./timeline";
import { triggerEffectorUnit } from "./trigger";

export type EffectorScopeOption = Scope | { scope: Scope; name?: string };

export interface ConnectEffectorOptions {
  appName?: string;
  autoOpen?: boolean;
  channel?: string;
  inspectorUrl?: string;
  /** Optional. Root effector units. The graph auto-discovers units from
   * effector's introspection, but `inspectGraph` is forward-only (it misses
   * units created before connecting) and exposes no live node — so pass your
   * model's units (or a module namespace's values) to get the full graph with
   * edges immediately and to enable triggering them from the inspector. */
  units?: readonly Unit<any>[];
  /** Optional. Scopes (from `fork()`). Scope-less computations are observed
   * automatically, but effector cannot enumerate forked scopes, so pass them to
   * see scoped activity in the timeline and to trigger units in a scope. */
  scopes?: readonly EffectorScopeOption[];
}

export interface EffectorInspectorConnection {
  readonly appId: string;
  readonly channel: string;
  dispose(): void;
  open(): Window | null;
  sendGraph(): void;
  addUnits(units: readonly Unit<any>[]): void;
  addScope(scope: Scope, name?: string): void;
  snapshot(): DevtoolsSnapshot;
}

/**
 * Connects a running effector app to the Virentia inspector over the same wire
 * protocol the Virentia bridge uses. The standalone inspector window/CLI needs
 * no changes — it sees an effector app exactly as it sees a Virentia one.
 *
 * Virentia-only inspector features that effector has no equivalent for degrade
 * gracefully: breakpoints are accepted and echoed but never pause execution,
 * and per-step durations are reported as 0.
 */
export function connectEffector(options: ConnectEffectorOptions = {}): EffectorInspectorConnection {
  const appId = createId("app");
  const appName = options.appName ?? "Effector app";
  const channel = options.channel ?? defaultDevtoolsChannel;
  const inspectorUrl = readConfiguredInspectorUrl(options.inspectorUrl);
  const endpoint = createAppEndpoint(channel, inspectorUrl);
  const breakpoints = new Set<string>();
  let disposed = false;
  let graphQueued = false;

  const graph = createEffectorGraph({ onChange: queueGraph });
  const timeline = createEffectorTimeline({
    onEvent: (event) => {
      endpoint.send({ type: "timeline", event });
    },
    onObserve: (unit) => {
      if (graph.observe(unit)) {
        queueGraph();
      }
    },
  });

  // Capture computations that run outside any scope.
  timeline.subscribeScope(null);

  function sendApp(): void {
    endpoint.send({ type: "app", appId, appName });
  }

  function sendGraph(): void {
    endpoint.send({ type: "graph", snapshot: graph.snapshot(breakpoints) });
  }

  function queueGraph(): void {
    if (graphQueued || disposed) {
      return;
    }

    graphQueued = true;
    queueMicrotask(() => {
      graphQueued = false;

      if (!disposed) {
        sendGraph();
      }
    });
  }

  function addUnits(units: readonly Unit<any>[]): void {
    if (disposed) {
      return;
    }

    graph.addUnits(units);
  }

  function addScope(scope: Scope, name?: string): void {
    if (disposed) {
      return;
    }

    const entry = graph.addScope(scope, name);
    timeline.subscribeScope(entry);
  }

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
      // Inert: effector has no chain-stop mechanism. We echo the selection so
      // the inspector's badge and node styling render, but never pause.
      breakpoints.clear();

      for (const id of message.nodeIds) {
        breakpoints.add(id);
      }

      sendGraph();
      return;
    }

    if (message.type === "trigger-unit") {
      void triggerEffectorUnit(message, graph).then((result) => {
        endpoint.send({
          type: "trigger-result",
          requestId: message.requestId,
          result,
        });
      });
    }
  });

  if (options.units) {
    addUnits(options.units);
  }

  for (const scope of options.scopes ?? []) {
    if (isScopeEntry(scope)) {
      addScope(scope.scope, scope.name);
    } else {
      addScope(scope);
    }
  }

  sendApp();
  sendGraph();

  if (options.autoOpen) {
    openInspectorWindow(channel, appName, inspectorUrl);
  }

  return {
    appId,
    channel,

    dispose() {
      if (disposed) {
        return;
      }

      disposed = true;
      unsubscribeMessages();
      timeline.dispose();
      graph.dispose();
      endpoint.dispose();
    },

    open() {
      return openInspectorWindow(channel, appName, inspectorUrl);
    },

    sendGraph,
    addUnits,
    addScope,

    snapshot() {
      return graph.snapshot(breakpoints);
    },
  };
}

export function openEffectorInspector(
  options: Omit<ConnectEffectorOptions, "autoOpen"> = {},
): EffectorInspectorConnection {
  return connectEffector({ ...options, autoOpen: true });
}

function isScopeEntry(value: EffectorScopeOption): value is { scope: Scope; name?: string } {
  return typeof value === "object" && value !== null && "scope" in value;
}
