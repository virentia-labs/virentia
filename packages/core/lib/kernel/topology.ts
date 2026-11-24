/**
 * Moves on every change of the graph's shape: an edge added or removed (`next`
 * lists, scoped edges) or a node registered as a synchronous sink. A walk over
 * the graph that depends only on its shape stays valid while this stands still
 * (see the in-place propagation in units/store.ts).
 */
export let topologyVersion = 0;

/**
 * Moves on the shape changes that can bring a walk to nodes it has not seen:
 * every change but a removal. What a walk found true of each node it reached
 * (the purity check) still holds after an edge is removed.
 */
export let growthVersion = 0;

export function topologyChanged(): void {
  topologyVersion++;
  growthVersion++;
}

let keepingWalks = 0;

/** An edge removed: nothing new is reachable. */
export function topologyShrank(): void {
  if (keepingWalks === 0) topologyVersion++;
}

/**
 * Edges removed until the matching `endWalkKeepingRemovals` leave walks
 * remembered over them valid: their dependents stay reachable another way.
 */
export function beginWalkKeepingRemovals(): void {
  keepingWalks++;
}

export function endWalkKeepingRemovals(): void {
  keepingWalks--;
}
