type UnitKind = "store" | "event" | "reaction";
type Tracker = ((kind: UnitKind) => void) | null;
let tracker: Tracker = null;

/** @internal A synchronous purity boundary for consumers of model-owned units. */
export function withUnitDeclarationTracker<T>(next: Tracker, body: () => T): T {
  const previous = tracker;
  tracker = next;
  try {
    return body();
  } finally {
    tracker = previous;
  }
}

/**
 * @internal `withUnitDeclarationTracker` for a caller that restores the
 * returned tracker itself, in its own `finally`: no body closure.
 */
export function setUnitDeclarationTracker(next: Tracker): Tracker {
  const previous = tracker;
  tracker = next;
  return previous;
}

export function trackUnitDeclaration(kind: UnitKind): void {
  tracker?.(kind);
}
