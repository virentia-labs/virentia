import type { EffectorAssociation } from "./types";

interface AssociationState {
  readonly suppressedEffector: Map<object, number>;
  readonly suppressedVirentia: Map<object, number>;
}

const associationState = new WeakMap<EffectorAssociation, AssociationState>();

export function shouldSkipEffector(association: EffectorAssociation, unit: object): boolean {
  return (getAssociationState(association).suppressedEffector.get(unit) ?? 0) > 0;
}

export function shouldSkipVirentia(association: EffectorAssociation, unit: object): boolean {
  return (getAssociationState(association).suppressedVirentia.get(unit) ?? 0) > 0;
}

export function suppressEffector<T>(
  association: EffectorAssociation,
  unit: object,
  fn: () => T,
): T {
  const state = getAssociationState(association);

  incrementSuppression(state.suppressedEffector, unit);

  try {
    return fn();
  } finally {
    decrementSuppression(state.suppressedEffector, unit);
  }
}

export function suppressVirentia(association: EffectorAssociation, unit: object): () => void {
  const state = getAssociationState(association);

  incrementSuppression(state.suppressedVirentia, unit);

  return () => {
    decrementSuppression(state.suppressedVirentia, unit);
  };
}

function getAssociationState(association: EffectorAssociation): AssociationState {
  let state = associationState.get(association);

  if (!state) {
    state = {
      suppressedEffector: new Map(),
      suppressedVirentia: new Map(),
    };
    associationState.set(association, state);
  }

  return state;
}

function incrementSuppression(map: Map<object, number>, unit: object): void {
  map.set(unit, (map.get(unit) ?? 0) + 1);
}

function decrementSuppression(map: Map<object, number>, unit: object): void {
  const next = (map.get(unit) ?? 0) - 1;

  if (next <= 0) {
    map.delete(unit);
  } else {
    map.set(unit, next);
  }
}
