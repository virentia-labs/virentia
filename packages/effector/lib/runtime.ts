import * as virentia from "@virentia/core";
import { applicationScopeOf, boundEventScopeOf, boundStoreScopeOf, modelScopeInstance, run as runVirentia } from "@virentia/core/internal";
import {
  allSettled as effectorAllSettled,
  clearNode as clearEffectorNode,
  createNode as createEffectorNode,
  is as effectorIs,
  launch,
  step as effectorStep,
} from "effector";
import type {
  Scope as EffectorScope,
  Unit as EffectorUnit,
  UnitTargetable as EffectorUnitTargetable,
} from "effector";
import { ensureAssociation } from "./associations";
import { shouldSkipVirentia, suppressEffector, suppressVirentia } from "./association-state";
import { createMissingAssociationError } from "./errors";
import { isEffectorUnit, isVirentiaEffect } from "./guards";
import type { BridgeCleanup, BridgeTarget, VirentiaBridgeTarget as VirentiaTarget, VirentiaBridgeUnit as VirentiaUnit } from "./internal-types";
import type { EffectorAssociation } from "./types";

export function installVirentiaToEffectorLink(
  from: VirentiaUnit,
  to: EffectorUnitTargetable<unknown>,
): void {
  installVirentiaToTargetLink(from, to, identity, true);
}

function installVirentiaToTargetLink(
  from: VirentiaUnit,
  to: BridgeTarget,
  map: (payload: unknown) => unknown,
  suppressEffectorWatch: boolean,
): BridgeCleanup {
  if (typeof from !== "function" && "subscribe" in from && boundStoreScopeOf(from)) {
    // A model computed must be observed through its fixed-scope API. Watching
    // its shared node globally also observes every sibling and bootstraps self.
    return from.subscribe((payload, scope) => {
      const association = ensureAssociation({ virentia: applicationScopeOf(scope) });
      if (shouldSkipVirentia(association, from as object)) return;
      runBridgeTarget(association, to, map(payload), { suppressWatch: suppressEffectorWatch });
    });
  }
  const watcher = virentia.reaction({
    on: from as virentia.Event<unknown>,
    run(payload) {
      const association = resolveAssociationFromVirentiaScope();

      if (shouldSkipVirentia(association, from as object)) return;

      runBridgeTarget(association, to, map(payload), {
        suppressWatch: suppressEffectorWatch,
      });
    },
  });

  const stop = () => { watcher.stop(); };
  const home = boundEventScopeOf(from);
  const model = home && modelScopeInstance(home) as { beforeDispose?(callback: () => void): () => void } | undefined;
  const detach = model?.beforeDispose?.(stop);
  return () => { detach?.(); stop(); };
}

function runBridgeTarget(
  association: EffectorAssociation,
  to: BridgeTarget,
  payload: unknown,
  options: { suppressWatch?: boolean; suppressReaction?: boolean } = {},
): void {
  if (isEffectorUnit(to)) {
    launchEffector(association, to as EffectorUnitTargetable<unknown>, payload, {
      suppressWatch: options.suppressWatch,
    });
    return;
  }

  emitVirentia(association, to as VirentiaTarget<unknown>, payload, {
    suppressReaction: options.suppressReaction,
  });
}

export async function callAssociation<T>(
  association: EffectorAssociation,
  unit: EffectorUnitTargetable<T> | VirentiaTarget<T>,
  payload: T,
): Promise<unknown> {
  if (isEffectorUnit(unit)) {
    return effectorAllSettled(unit, {
      params: payload,
      scope: association.effector,
    } as never);
  }

  if (isVirentiaEffect(unit)) {
    return dispatchVirentia(association, unit, payload);
  }

  await dispatchVirentia(association, unit, payload);
}

function dispatchVirentia<T>(association: EffectorAssociation, unit: VirentiaTarget<T>, payload: T): Promise<unknown> {
  const home = typeof unit === "function"
    ? boundEventScopeOf(unit) ?? (isVirentiaEffect(unit) ? boundStoreScopeOf(unit.pending) : undefined)
    : boundStoreScopeOf(unit);
  if (home && applicationScopeOf(home) !== association.virentia)
    throw new Error("Virentia target belongs to another associated application");

  if (typeof unit === "function")
    return virentia.scoped(association.virentia, () => (unit as (value: T) => Promise<unknown>)(payload));

  if (home) {
    // The facade owns codecs, writability and disposal guards. An async result
    // makes scoped wait for reactions spawned by this synchronous assignment.
    return virentia.scoped(association.virentia, () => {
      unit.value = payload;
      return Promise.resolve();
    });
  }
  return runVirentia({ unit: unit.node as virentia.Node, payload, scope: association.virentia });
}

function launchEffector<T>(
  association: EffectorAssociation,
  unit: EffectorUnitTargetable<T>,
  payload: T,
  options: { suppressWatch?: boolean } = {},
): void {
  const launchUnit = () => {
    launch({
      target: unit,
      params: payload,
      scope: association.effector,
    });
  };

  if (options.suppressWatch) {
    suppressEffector(association, unit, launchUnit);
    return;
  }

  launchUnit();
}

export function emitVirentia<T>(
  association: EffectorAssociation,
  unit: VirentiaTarget<T>,
  payload: T,
  options: { suppressReaction?: boolean } = {},
): void {
  const release = options.suppressReaction ? suppressVirentia(association, unit as object) : null;

  let settled: Promise<unknown>;
  try {
    settled = dispatchVirentia(association, unit, payload);
  } catch (error) {
    release?.();
    throw error;
  }

  if (release) {
    void settled.finally(release);
  }
}

export function resolveAssociationFromEffectorScope(
  scope: EffectorScope | null | undefined,
): EffectorAssociation {
  if (!scope) {
    throw createMissingAssociationError({});
  }

  const association = ensureAssociation({ effector: scope });
  const activeVirentiaScope = virentia.getCurrentScope();

  if (activeVirentiaScope && applicationScopeOf(activeVirentiaScope) !== association.virentia) {
    throw new Error("Effector scope is associated with another Virentia scope");
  }

  return association;
}

export function resolveAssociationFromVirentiaScope(): EffectorAssociation {
  const activeVirentiaScope = virentia.getCurrentScope();

  if (!activeVirentiaScope) {
    throw createMissingAssociationError({});
  }

  return ensureAssociation({ virentia: applicationScopeOf(activeVirentiaScope) });
}

export function createEffectorScopeNode<T>(
  unit: EffectorUnit<T>,
  fn: (payload: T, scope: EffectorScope | null | undefined) => void,
): BridgeCleanup {
  const node = createEffectorNode({
    parent: [unit] as any,
    node: [
      ...(effectorIs.store(unit)
        ? [
            effectorStep.mov({
              store: (unit as any).stateRef,
              to: "stack",
            }),
          ]
        : []),
      effectorStep.run({
        fn(payload: T, _local: unknown, stack: { scope?: EffectorScope | null }) {
          fn(payload, stack.scope);
        },
      }),
    ],
    family: {
      owners: [unit],
    },
  });

  return () => {
    clearEffectorNode(node);
  };
}

function identity<T>(value: T): T {
  return value;
}
