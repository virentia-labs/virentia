import { serializeDevtoolsValue, type DevtoolsTimelineEvent } from "@virentia/core/devtools";
import { inspect } from "effector/inspect";
import type { Subscription } from "effector";
import { isPrimaryUnit, isUnitOp } from "./kinds";
import type { EffectorScopeEntry } from "./types";

interface InspectMessage {
  type: "update" | "error";
  value: unknown;
  error?: unknown;
  kind?: string;
  id: string;
  name?: string;
  derived?: boolean;
  meta?: { derived?: number | boolean; named?: unknown };
}

export interface EffectorTimeline {
  subscribeScope(entry: EffectorScopeEntry | null): void;
  dispose(): void;
}

export function createEffectorTimeline(options: {
  onEvent: (event: DevtoolsTimelineEvent) => void;
  onObserve?: (unit: {
    id: string;
    kind?: string;
    name?: string;
    derived: boolean;
    named?: unknown;
  }) => void;
}): EffectorTimeline {
  const subscriptions = new Set<Subscription>();
  const subscribedScopeIds = new Set<string>();
  let scopelessSubscribed = false;
  let disposed = false;
  let sequence = 0;

  const handle = (message: InspectMessage, entry: EffectorScopeEntry | null): void => {
    // Register any user-facing unit we see computing, so the graph fills in even
    // when no `units` were passed.
    if (isUnitOp(message.kind)) {
      options.onObserve?.({
        id: String(message.id),
        kind: message.kind,
        name: message.name,
        derived: isDerived(message),
        named: message.meta?.named,
      });
    }

    if (message.type === "error") {
      // Drop throws originating in internal operation nodes (on/map/sample/...);
      // keep only those attributable to a user-facing unit.
      if (!isUnitOp(message.kind)) {
        return;
      }

      options.onEvent(toTimelineEvent(++sequence, message, entry, true));
      return;
    }

    if (message.type !== "update") {
      return;
    }

    const failure = isFailure(message);

    // One row per primary unit computation (collapses the ~16 derived sub-unit
    // updates effector emits per trigger), plus any failure signal.
    if (!failure && !isPrimaryUnit(message.kind, isDerived(message), message.meta?.named)) {
      return;
    }

    options.onEvent(toTimelineEvent(++sequence, message, entry, failure));
  };

  return {
    subscribeScope(entry) {
      if (disposed) {
        return;
      }

      if (entry === null) {
        if (scopelessSubscribed) {
          return;
        }

        scopelessSubscribed = true;
        subscriptions.add(inspect({ fn: (message) => handle(message as InspectMessage, null) }));
        return;
      }

      if (subscribedScopeIds.has(entry.id)) {
        return;
      }

      subscribedScopeIds.add(entry.id);
      subscriptions.add(
        inspect({
          scope: entry.scope,
          fn: (message) => handle(message as InspectMessage, entry),
        }),
      );
    },

    dispose() {
      disposed = true;

      for (const subscription of subscriptions) {
        subscription.unsubscribe();
      }

      subscriptions.clear();
      subscribedScopeIds.clear();
      scopelessSubscribed = false;
    },
  };
}

function toTimelineEvent(
  sequence: number,
  message: InspectMessage,
  entry: EffectorScopeEntry | null,
  failed: boolean,
): DevtoolsTimelineEvent {
  const nodeType = message.kind ?? "node";
  const nodeId = String(message.id);

  return {
    id: `timeline:${sequence}`,
    sequence,
    nodeId,
    nodeName: message.name ?? `${nodeType} #${nodeId}`,
    nodeType,
    scopeId: entry?.id ?? null,
    scopeName: entry?.name ?? null,
    payload: serializeDevtoolsValue(message.value),
    result: serializeDevtoolsValue(failed ? failureValue(message) : message.value),
    failed,
    stopped: false,
    breakpoint: false,
    duration: 0,
    timestamp: now(),
  };
}

function isDerived(message: InspectMessage): boolean {
  return Boolean(message.meta?.derived ?? message.derived);
}

function isFailure(message: InspectMessage): boolean {
  if (message.name === "fail" || message.name === "failData") {
    return true;
  }

  return message.name === "finally" && readStatus(message.value) === "fail";
}

function failureValue(message: InspectMessage): unknown {
  if (message.type === "error") {
    return message.error;
  }

  const value = message.value;

  if (value && typeof value === "object" && "error" in value) {
    return (value as { error: unknown }).error;
  }

  return value;
}

function readStatus(value: unknown): string | undefined {
  if (value && typeof value === "object" && "status" in value) {
    return (value as { status?: string }).status;
  }

  return undefined;
}

function now(): number {
  return globalThis.performance?.now() ?? Date.now();
}
