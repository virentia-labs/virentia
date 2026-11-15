// Only model() can produce branded dynamic declarations. Keep its two hooks
// out of the generic registry's staticModel-only dependency graph.
import type { instantiateDynamic, initializeDynamicModelValues } from "./definition";

export let dynamicInstantiation: typeof instantiateDynamic | undefined;
export let dynamicInitialization: typeof initializeDynamicModelValues | undefined;

export function setDynamicModelRuntime(
  instantiate: typeof instantiateDynamic,
  initialize: typeof initializeDynamicModelValues,
): void {
  dynamicInstantiation = instantiate;
  dynamicInitialization = initialize;
}
