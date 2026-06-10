import {
  serializeDevtoolsValue,
  type InspectorMessage,
  type TriggerUnitResult,
} from "@virentia/core/devtools";
import { allSettled, is, launch, type Node as EffectorGraphNode } from "effector";
import type { EffectorGraph } from "./graph";

type TriggerMessage = Extract<InspectorMessage, { type: "trigger-unit" }>;

export async function triggerEffectorUnit(
  message: TriggerMessage,
  graph: EffectorGraph,
): Promise<TriggerUnitResult> {
  const node = graph.getNode(message.nodeId);
  const unit = graph.getUnit(message.nodeId);

  if (!node && !unit) {
    return fail(`Unknown node: ${message.nodeId}`);
  }

  let scope = null;

  if (message.scopeId) {
    scope = graph.getScope(message.scopeId);

    if (!scope) {
      return fail(`Unknown scope: ${message.scopeId}`);
    }
  }

  try {
    // Effects cannot be launched by params/node — that corrupts effector's
    // stack. They must run through the unit (allSettled with a scope, or a
    // direct call).
    if (unit && is.effect(unit)) {
      if (scope) {
        const result = await allSettled(unit, { scope, params: message.payload });

        if (result.status === "fail") {
          return { ok: false, error: serializeDevtoolsValue(result.value) };
        }

        return { ok: true };
      }

      await unit(message.payload);
      return { ok: true };
    }

    if (!unit && node?.meta.op === "effect") {
      return fail("Cannot trigger this effect: pass it via connectEffector({ units }).");
    }

    // Events/stores: launch accepts a unit or a raw graphite node.
    const target = (unit ?? node) as unknown as EffectorGraphNode;

    if (scope) {
      launch({ target, params: message.payload, scope });
    } else {
      launch({ target, params: message.payload });
    }

    return { ok: true };
  } catch (error) {
    return { ok: false, error: serializeDevtoolsValue(error) };
  }
}

function fail(message: string): TriggerUnitResult {
  return { ok: false, error: serializeDevtoolsValue(new Error(message)) };
}
