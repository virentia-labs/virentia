export interface Scope {
  readonly values: Map<symbol, unknown>;
  readonly handlers: Map<object, (...args: any[]) => unknown>;
}
