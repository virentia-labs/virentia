import type { DevtoolsSnapshot } from "@virentia/core/devtools";

export { connectVirentiaInspector } from "@virentia/core/devtools";
export type {
  DevtoolsGraphNode,
  DevtoolsSnapshot,
  DevtoolsTimelineEvent,
  TriggerUnitResult,
  VirentiaInspectorClient,
} from "@virentia/core/devtools";

export const emptySnapshot: DevtoolsSnapshot = {
  nodes: [],
  edges: [],
  scopes: [],
  breakpoints: [],
};
