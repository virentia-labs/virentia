import type {
  EffectorAssociation,
  EffectorAssociationConfig,
  EffectorAssociationLookup,
  EffectorAssociations,
} from "./types";
import { createMissingAssociationError } from "./errors";

export const effectorAssociations: EffectorAssociations = {
  byVirentia: new WeakMap(),
  byEffector: new WeakMap(),
};

export function associate(config: EffectorAssociationConfig): EffectorAssociation {
  if (!config.virentia) {
    throw new Error("Effector association requires a Virentia scope");
  }

  if (!config.effector) {
    throw new Error("Effector association requires an Effector scope");
  }

  const existingByVirentia = effectorAssociations.byVirentia.get(config.virentia);
  const existingByEffector = effectorAssociations.byEffector.get(config.effector);

  if (existingByVirentia && existingByVirentia.effector !== config.effector) {
    throw new Error("Virentia scope is already associated with another Effector scope");
  }

  if (existingByEffector && existingByEffector.virentia !== config.virentia) {
    throw new Error("Effector scope is already associated with another Virentia scope");
  }

  const existing = existingByVirentia ?? existingByEffector;

  if (existing) {
    effectorAssociations.byVirentia.set(config.virentia, existing);
    effectorAssociations.byEffector.set(config.effector, existing);
    return existing;
  }

  const association: EffectorAssociation = {
    virentia: config.virentia,
    effector: config.effector,
  };

  effectorAssociations.byVirentia.set(config.virentia, association);
  effectorAssociations.byEffector.set(config.effector, association);

  return association;
}

export function ensureAssociation(config: EffectorAssociationLookup = {}): EffectorAssociation {
  const association = findAssociation(config);

  if (!association) {
    throw createMissingAssociationError(config);
  }

  return association;
}

function findAssociation(config: EffectorAssociationLookup = {}): EffectorAssociation | null {
  let association: EffectorAssociation | undefined;

  if (config.virentia) {
    association = effectorAssociations.byVirentia.get(config.virentia);

    if (association && config.effector && association.effector !== config.effector) {
      return null;
    }

    if (association) return association;
  }

  if (config.effector) {
    association = effectorAssociations.byEffector.get(config.effector);

    if (association && config.virentia && association.virentia !== config.virentia) {
      return null;
    }

    if (association) return association;
  }

  return null;
}
