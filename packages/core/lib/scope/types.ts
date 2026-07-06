export interface Scope {
  readonly values: Map<symbol, unknown>;
  readonly handlers: Map<object, (...args: any[]) => unknown>;
  // Per-scope injectables (an API client, a clock, a logger) provided per scope.
  // Kept separate from `values` on purpose: dependencies are wiring, not state,
  // so they are never serialized or hydrated.
  readonly deps: Map<symbol, unknown>;
}
