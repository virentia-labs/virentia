import * as virentia from "@virentia/core";
import { run as runVirentia } from "@virentia/core/internal";
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
import type { BridgeCleanup, BridgeTarget } from "./internal-types";
import type { EffectorAssociation, VirentiaTarget, VirentiaUnit } from "./types";

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

  return () => {
    watcher.stop();
  };
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
    return virentia.scoped(association.virentia, () => unit(payload as never));
  }

  await runVirentia({
    unit: (unit as VirentiaTarget<T>).node,
    payload,
    scope: association.virentia,
  });
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

  const settled = runVirentia({
    unit: unit.node,
    payload,
    scope: association.virentia,
  });

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

  if (activeVirentiaScope && activeVirentiaScope !== association.virentia) {
    throw new Error("Effector scope is associated with another Virentia scope");
  }

  return association;
}

export function resolveAssociationFromVirentiaScope(): EffectorAssociation {
  const activeVirentiaScope = virentia.getCurrentScope();

  if (!activeVirentiaScope) {
    throw createMissingAssociationError({});
  }

  return ensureAssociation({ virentia: activeVirentiaScope });
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
