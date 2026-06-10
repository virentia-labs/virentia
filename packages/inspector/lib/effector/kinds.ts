import type { EffectorNode, EffectorNodeMeta } from "./types";

/**
 * Effector ops that correspond to user-facing units (the ones a developer
 * creates with createStore/createEvent/createEffect). Everything else
 * (map, on, sample, combine, filterMap, fx, mov, compute, merge, prepend,
 * watch, ...) is an internal operation node used to wire units together.
 */
const UNIT_OPS = new Set(["store", "event", "effect"]);

export interface NodeClassification {
  type: string;
  key: boolean;
  callable: boolean;
  writable: boolean;
  internal: boolean;
  derived: boolean;
}

/**
 * A "unit" node is one the inspector renders as a graph vertex. Operation
 * nodes are treated as internal — hidden from the snapshot, with reactive
 * edges flattened through them so visible units stay connected.
 */
export function isUnitOp(op: string | undefined): boolean {
  return op !== undefined && UNIT_OPS.has(op);
}

/**
 * Service units that effector attaches to stores/effects (a store's
 * `updates`/`reinit`, an effect's `done`/`fail`/`finally`/`pending`/...) carry
 * a non-empty `meta.named`. Developer-created units have `named === null`.
 */
export function isServiceNamed(named: unknown): boolean {
  return typeof named === "string" && named.length > 0;
}

/** A primary unit is a user-created store/event/effect — not derived, not service. */
export function isPrimaryUnit(op: string | undefined, derived: boolean, named: unknown): boolean {
  return isUnitOp(op) && !derived && !isServiceNamed(named);
}

export function classifyNode(node: EffectorNode): NodeClassification {
  return classifyMeta(node.meta);
}

export function classifyMeta(meta: EffectorNodeMeta): NodeClassification {
  const op = meta.op;
  const derived = Boolean(meta.derived);
  const unit = isUnitOp(op);

  return {
    type: op ?? "node",
    // Primary units populate the default view; derived/service units (map
    // results, combine, a store's updates/reinit, an effect's done/fail/
    // pending/...) only show under "Show all units". Operation nodes are
    // internal and excluded from the snapshot entirely.
    key: isPrimaryUnit(op, derived, meta.named),
    callable: op === "event" || op === "effect",
    writable: op === "store" && !derived,
    internal: !unit,
    derived,
  };
}

export function classifyKind(kind: string | undefined, derived: boolean): NodeClassification {
  return classifyMeta({ op: kind, derived });
}
