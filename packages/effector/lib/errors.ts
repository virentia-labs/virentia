import type { EffectorAssociationLookup } from "./types";

export function createMissingAssociationError(config: EffectorAssociationLookup): Error {
  if (config.effector) {
    return new Error("Effector association is missing for provided Effector scope");
  }

  if (config.virentia) {
    return new Error("Effector association is missing for provided Virentia scope");
  }

  return new Error(
    "Effector association is missing. Call associate({ virentia, effector }) before using fooled units.",
  );
}
