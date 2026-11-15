import type { Scope } from "../scope/types";

/** Private lifetime check for instance-bound observation handles. */
export const boundStoreAlive = Symbol("virentia.boundStoreAlive");

// Scope belongs to a model store's subscription handle, which is already lazy.
// Ordinary reads and instance construction do not allocate binding metadata.
const subscriptionScopes = new WeakMap<Function, Scope>();
let modelStoreScope: ((scope: Scope, key: symbol) => Scope) | undefined;
let nativeStoreIdentity: ((unit: object) => boolean) | undefined;
let scopedComputedInitializer: ((unit: object, scope: Scope) => boolean) | undefined;

// Keep graph/reaction independent of the store implementation at runtime.
export function setStoreObservationHooks(
  nativeIdentity: (unit: object) => boolean,
  initializeComputed: (unit: object, scope: Scope) => boolean,
): void {
  nativeStoreIdentity = nativeIdentity;
  scopedComputedInitializer = initializeComputed;
}
export function isNativeStoreUnit(unit: object): boolean {
  return nativeStoreIdentity?.(unit) ?? false;
}
export function initializeScopedComputed(unit: object, scope: Scope): boolean {
  return scopedComputedInitializer?.(unit, scope) ?? false;
}

export function setModelStoreScopeResolver(resolve: (scope: Scope, key: symbol) => Scope): void {
  modelStoreScope = resolve;
}
export function resolveModelStoreScope(scope: Scope, key: symbol): Scope {
  return modelStoreScope?.(scope, key) ?? scope;
}

export function bindStoreSubscription<T extends Function>(subscribe: T, scope: Scope): T {
  subscriptionScopes.set(subscribe, scope);
  return subscribe;
}

/** @internal A bound model store cannot be rebound to its consumer's app scope. */
export function boundStoreScopeOf(unit: { readonly subscribe: Function }): Scope | undefined {
  return subscriptionScopes.get(unit.subscribe);
}
