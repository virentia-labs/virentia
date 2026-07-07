// @virentia/core/internal — low-level building blocks for authoring custom units
// and stores (see @virentia/mutable for an example). App code should not need
// this; use stores/events/effects/reactions from the main entry.
//
// These re-export the same singleton modules the main entry uses (the bundler
// code-splits them into a shared chunk), so a package built on this subpath
// shares core's transaction, scope, and graph state instead of getting its own
// copy. Treat the surface as advanced and less stable than the main API.

export { node, run, context, withContexts } from "./kernel";
export type * from "./kernel";

// Dependency tracking: call `trackNode(node)` from a read so the read registers
// as a dependency of the surrounding computed/reaction; `collectNodes` scopes a
// synchronous collection window.
export { collectNodes, isTracking, trackNode } from "./graph/deps";

// Ambient scope access. `requireActiveScope` throws the actionable "Scope is
// required" error when none is active.
export { getActiveScope, requireActiveScope, setActiveScope } from "./scope/internal";

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
