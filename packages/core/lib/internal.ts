// @virentia/core/internal — low-level building blocks for authoring custom units
// and stores (see @virentia/mutable for an example). App code should not need
// this; use stores/events/effects/reactions from the main entry.
//
// These re-export the same singleton modules the main entry uses (the bundler
// code-splits them into a shared chunk), so a package built on this subpath
// shares core's transaction, scope, and graph state instead of getting its own
// copy. Treat the surface as advanced and less stable than the main API.

export { node, run, runDetached, context, withContexts } from "./kernel";
export { registerSynchronousSink, registerSynchronousMethodSink, queuedSlot } from "./kernel/run";
export { retainShapes } from "./kernel/shapes";
export { registerOwnedNode, prepareOwnedNode } from "./kernel/create";
export type * from "./kernel";
export {
  reconcileScopedEdges,
  reconcileScopedSource,
  detachScopedDependent,
} from "./kernel/scoped-edges";
export { withInspectorMeta } from "./kernel/inspector";
export {
  isInspectorEnabled,
  isInspectorDiscoverable,
  registerInspectorNode,
  prepareInspectorSnapshotNode,
} from "./kernel/inspector";

// Dependency tracking: call `trackNode(node)` from a read so the read registers
// as a dependency of the surrounding computed/reaction; `collectNodes` scopes a
// synchronous collection window.
export { collectNodes, collectScopedNodes, isTracking, trackNode } from "./graph/deps";

// Ambient scope access. `requireActiveScope` throws the actionable "Scope is
// required" error when none is active.
export { getActiveScope, requireActiveScope, setActiveScope } from "./scope/internal";
export { runScopeFrame } from "./scope/internal";

// Framework runtimes can provide a per-instance view of one shared event node.
// Reactions on the view infer its bound scope unless they specify `scope:`.
export { bindEventToScope, boundEventScopeOf } from "./units/event";
export { boundStoreScopeOf } from "./units/binding";

// A reaction body runs with a per-run micro-scope installed as the ambient
// scope (a tracking overlay sharing the real scope's maps by reference). A
// custom store must unwrap it wherever scope IDENTITY matters — keying its own
// per-scope state, staging transaction writes, and above all the scope handed
// to subscribers, which scope-filtering consumers (useUnit) compare by `===`.
export {
  createMicroScope,
  readMicroDependencies,
  isMicroScope,
  unwrapMicroScope,
} from "./scope/micro";
export { peekMicroDependencies, takeMicroDependencies } from "./scope/micro";
// Exact synchronous SID namespace for repeated component/factory declarations.
export {
  releaseStoreDeclaration,
  trackStoreDeclaration,
  markStoreTransient,
  materializeSnapshotStore,
  resolveStoreSid,
  applicationScopeOf,
  modelScopeInstance,
  withSidScope,
  withStoreDeclarationTracker,
} from "./scope/snapshot";
export type { StoreDeclaration } from "./scope/snapshot";
export { withUnitDeclarationTracker, setUnitDeclarationTracker } from "./graph/declaration";
export { setOwner } from "./graph/owner";
export { setSidScope } from "./scope/snapshot";
export { setSidScopeFrame } from "./scope/snapshot";

// A plain store's declaration-time initial (what a fresh scope reads before any
// write). Custom operators build reset-like behavior on it; computeds have no
// stored initial — check with the predicate instead of catching.
export {
  captureScopeSnapshot,
  hasInitialValue,
  initialValueOf,
  trackScopedRead,
  fixedStoreNodeOf,
  storeModeOf,
  storeReadScopeOf,
  storeNotificationScopeOf,
} from "./units/store";

// Optional entity-model bindings use this structural protocol. Keeping the
// protocol here lets UI packages recognize models without importing
// @virentia/core/models (and its optional TypeBox peer) themselves.
export {
  isModelDefinition,
  isModelInstance,
  isModelQuery,
  fieldIsOneWay,
  queryReactivity,
  subscribeInstance,
} from "./models/protocol";
export {
  modelDefinitionBindingOf,
  modelValueBindingOf,
  bindModelValueInScope,
  modelInstanceBindingOf,
  modelQueryBindingOf,
  modelSingletonBindingOf,
  resolveModelInstance,
  modelDefaultCreator,
  modelViewSnapshotOf,
  modelViewCaptureOf,
  modelDefaultViewSnapshotOf,
  directModelMemberOf,
} from "./models/bindings";
export { afterBulkRemoval } from "./models/bulk-removal";
export { nativeModel, nativeTrait } from "./models/native";
export { scopedModelValue } from "./models/value";
export { getModelSetupContext } from "./models/bindings";
export type { NativeTrait } from "./models/native";
export type {
  DirectModelMember,
  ModelCollectionBinding,
  ModelDefinitionBinding,
  ModelInstanceBinding,
  ModelDisposalTrace,
  ModelViewCapture,
  ModelQueryBinding,
  ModelVersionBinding,
  ModelValueContext,
} from "./models/bindings";

// Transaction lifecycle. Writes registered with `writeTransactionStore` are
// batched and committed together on the transaction boundary; each target's
// `commit` reports whether it changed and how to notify.
export {
  commitActiveTransaction,
  enterTransaction,
  exitTransaction,
  readTransactionStore,
  withTransaction,
  writeTransactionStore,
} from "./kernel/transaction";
export type { StoreCommitResult, StoreTransactionTarget } from "./kernel/transaction";
export { sequenceBinding, sequenceBindingOf } from "./sequence";
export type { SequenceBinding, SequenceOperation } from "./sequence";
