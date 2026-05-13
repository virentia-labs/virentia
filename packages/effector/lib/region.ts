import * as core from "@virentia/core";
import type { Unit } from "./types";

const regionOwner = Symbol("virentia.effector.regionOwner");
const regionNode = Symbol("virentia.effector.regionNode");

export interface Node extends core.Node {
  seq: unknown[];
  family: {
    owners: unknown[];
    links: unknown[];
  };
  scope: Record<string, unknown>;
  graphite: Node;
  meta: Record<string, unknown>;
  dispose(): void;
  [Symbol.dispose](): void;
  [regionOwner]?: core.Owner;
}

export interface StepConfig {
  fn?: (payload: unknown, scope?: unknown, stack?: { a?: unknown }) => unknown;
}

export const step = {
  compute(config: StepConfig = {}): StepConfig & { type: "compute" } {
    return { ...config, type: "compute" };
  },

  run(config: StepConfig = {}): StepConfig & { type: "run" } {
    return { ...config, type: "run" };
  },
};

export function createNode(
  config: { meta?: Record<string, unknown>; node?: unknown[] } = {},
): Node {
  const parentOwner = core.getOwner();
  const node = core.owner((_dispose, owner) => {
    const next = {
      seq: [...(config.node ?? [])],
      family: {
        owners: [],
        links: [],
      },
      scope: {},
      meta: config.meta ?? {},
      enabled: true,
      [regionOwner]: owner,
    } as unknown as Node;

    next.graphite = next;
    return next;
  });

  if (parentOwner) {
    parentOwner.onCleanup(() => {
      clearNode(node);
    });
  }

  return node;
}

export function withRegion<T>(region: Node | { graphite?: Node }, fn: () => T): T {
  const node = getCompatNode(region);

  return core.withOwner(node?.[regionOwner] ?? null, fn);
}

export function clearNode(target: Node | Unit<any> | { graphite?: Node } | null | undefined): void {
  if (!target) {
    return;
  }

  const node = getCompatNode(target);

  if (!node) {
    return;
  }

  node.enabled = false;
  node.next = [];
  node.seq.length = 0;
  node[regionOwner]?.dispose();
}

export function attachUnitRegion(unit: Unit<any>): void {
  const node = ensureCompatNode(unit.node);

  Object.defineProperty(unit, "graphite", {
    configurable: true,
    value: node,
  });

  const owner = core.getOwner();

  if (!owner) {
    return;
  }

  Object.defineProperty(unit, regionNode, {
    configurable: true,
    value: node,
  });

  owner.onCleanup(() => {
    clearNode(unit);
  });
}

export function attachCompatNode(node: core.Node): Node {
  return ensureCompatNode(node);
}

function getCompatNode(target: Node | Unit<any> | { graphite?: Node }): Node | undefined {
  if (isCompatNode(target)) {
    return target;
  }

  if (isObject(target) && regionNode in target) {
    return target[regionNode as keyof typeof target] as Node;
  }

  if (hasGraphite(target)) {
    return target.graphite;
  }

  if (isObject(target) && "node" in target) {
    return ensureCompatNode((target as Unit<any>).node);
  }

  return undefined;
}

function ensureCompatNode(node: core.Node): Node {
  const compat = node as Node;

  compat.seq ??= [];
  compat.family ??= {
    owners: [],
    links: [],
  };
  compat.scope ??= {};
  compat.meta ??= {};
  compat.graphite ??= compat;

  return compat;
}

function isCompatNode(value: unknown): value is Node {
  return Boolean(
    value && typeof value === "object" && "seq" in value && "family" in value && "scope" in value,
  );
}

function isObject(value: unknown): value is object {
  return (typeof value === "object" || typeof value === "function") && value !== null;
}

function hasGraphite(value: unknown): value is { graphite: Node } {
  return isObject(value) && "graphite" in value && Boolean((value as { graphite?: Node }).graphite);
}
