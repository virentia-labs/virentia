import type { Scope, Unit } from "effector";

/**
 * Effector's internal graph node ("graphite"). It is not part of effector's
 * public typings, so we describe only the fields the inspector reads.
 */
export interface EffectorNode {
  id: string;
  next: EffectorNode[];
  seq: unknown[];
  scope: Record<string, unknown>;
  meta: EffectorNodeMeta;
  family: {
    type: "regular" | "crosslink" | "domain";
    links: EffectorNode[];
    owners: EffectorNode[];
  };
}

export interface EffectorNodeMeta {
  op?: string;
  name?: string;
  named?: string;
  derived?: number | boolean;
  unitId?: string;
  sid?: string | null;
  [field: string]: unknown;
}

export type AnyEffectorUnit = Unit<unknown>;

/** A unit object carrying its graphite node (effector attaches it at runtime). */
export interface UnitWithGraphite {
  graphite: EffectorNode;
  shortName?: string;
  sid?: string | null;
}

export interface EffectorScopeEntry {
  id: string;
  scope: Scope;
  name?: string;
}

export function readGraphite(unit: unknown): EffectorNode | undefined {
  if (!unit || (typeof unit !== "object" && typeof unit !== "function")) {
    return undefined;
  }

  const graphite = (unit as { graphite?: unknown }).graphite;

  return isEffectorNode(graphite) ? graphite : undefined;
}

export function isEffectorNode(value: unknown): value is EffectorNode {
  return Boolean(
    value &&
    typeof value === "object" &&
    "id" in value &&
    "family" in value &&
    Array.isArray((value as EffectorNode).next),
  );
}
