import type { Scope } from "./types";
import { unwrapMicroScope } from "./micro";
import { isPendingStoreValue, readTransactionStore } from "../kernel/transaction";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | {
      readonly [key: string]: JsonValue;
    };

/** JSON-safe writable store values keyed by their stable, resolved SID. */
export type ScopeSnapshot = Record<string, JsonValue>;

export interface SnapshotStore {
  readonly sid: string;
  readonly id: symbol;
  readonly identity: object;
}

/** @internal Identity of a plain store created during a synchronous declaration frame. */
export interface StoreDeclaration {
  readonly id: symbol;
  readonly sid?: string;
  readonly identity: object;
}

interface SnapshotState {
  pending: ScopeSnapshot;
  stores: Map<string, SnapshotStore>;
}

const states = new WeakMap<Scope, SnapshotState>();
let sidScope = "";
let declarationTracker: ((declaration: StoreDeclaration) => void) | undefined;

/** @internal Observe stores created in this synchronous frame, without owning their lifetime. */
export function withStoreDeclarationTracker<T>(
  callback: (declaration: StoreDeclaration) => void,
  body: () => T,
): T {
  const previous = declarationTracker;
  declarationTracker = callback;
  try {
    return body();
  } finally {
    declarationTracker = previous;
  }
}

/** @internal Called only after a store's proxy and its backing maps are ready. */
export function trackStoreDeclaration(declaration: StoreDeclaration): void {
  declarationTracker?.(declaration);
}

/** @internal Release one component-owned store after its reactions have stopped. */
export function releaseStoreDeclaration(scope: Scope, declaration: StoreDeclaration): void {
  scope = unwrapMicroScope(scope);
  const state = states.get(scope);
  const registered = declaration.sid === undefined ? undefined : state?.stores.get(declaration.sid);
  if (registered && registered.identity !== declaration.identity) return;
  scope.values.delete(declaration.id);
  if (registered) state!.stores.delete(registered.sid);
}

/** @internal Synchronous declaration namespace; restored immediately, including for a promise result. */
export function withSidScope<T>(prefix: string, callback: () => T): T {
  const previous = sidScope;
  sidScope = prefix;
  try {
    return callback();
  } finally {
    sidScope = previous;
  }
}

/** @internal Resolve at declaration, not at a later read in another owner. */
export function resolveStoreSid(sid: string | undefined): string | undefined {
  if (sid === undefined) return undefined;
  if (typeof sid !== "string" || !sid.length)
    throw new TypeError("Store SID must be a non-empty string");
  return sidScope ? `${sidScope}/${sid}` : sid;
}

/** @internal Snapshot input is cloned so requests cannot share mutable payloads. */
export function initializeSnapshot(scope: Scope, snapshot: ScopeSnapshot): void {
  const pending = cloneJson(snapshot, "snapshot", new Set());
  if (!pending || Array.isArray(pending) || typeof pending !== "object") {
    throw new TypeError("Scope snapshot must be a plain record of SID values");
  }
  states.set(scope, { pending: pending as ScopeSnapshot, stores: new Map() });
}

/** @internal Copy lazy SID restoration into a temporary in-memory read scope. */
export function copyScopeSnapshotState(source: Scope, target: Scope): void {
  const state = states.get(source);
  if (!state) return;
  states.set(target, {
    pending: cloneJson(state.pending, "snapshot", new Set()) as ScopeSnapshot,
    stores: new Map(state.stores),
  });
}

/** @internal Bind only writable stores; computed caches never enter the registry. */
export function materializeSnapshotStore(scope: Scope, store: SnapshotStore): void {
  let state = states.get(scope);
  if (!state) {
    state = { pending: Object.create(null) as ScopeSnapshot, stores: new Map() };
    states.set(scope, state);
  }
  const existing = state.stores.get(store.sid);
  if (existing && existing.identity !== store.identity) {
    throw new Error(
      `Duplicate store SID "${store.sid}" in one scope. ` +
        "Give each store a unique SID or namespace repeated factory/component instances with withSidScope().",
    );
  }
  state.stores.set(store.sid, store);
  if (
    !scope.values.has(store.id) &&
    Object.prototype.hasOwnProperty.call(state.pending, store.sid)
  ) {
    scope.values.set(store.id, state.pending[store.sid]);
  }
  delete state.pending[store.sid];
}

/**
 * Serialize materialized writable SID stores; handlers, dependencies and derived caches are excluded.
 * The result is cloned JSON data, not HTML-safe text for embedding in a script tag.
 *
 * Use explicit request scopes and synchronous render frames. This API does not
 * change core's existing single ambient async scope or eager inspector retention
 * of scopes/nodes; it does not make concurrent async scoped() calls isolated.
 */
export function serialize(scope: Scope): ScopeSnapshot {
  scope = unwrapMicroScope(scope);
  const snapshot = Object.create(null) as ScopeSnapshot;
  const state = states.get(scope);
  if (!state) return snapshot;
  for (const [sid, store] of state.stores) {
    if (scope.values.has(store.id)) {
      const pending = readTransactionStore(scope, store.id);
      const value = isPendingStoreValue(pending) ? pending : scope.values.get(store.id);
      snapshot[sid] = cloneJson(value, `store "${sid}"`, new Set());
    }
  }
  return snapshot;
}

function cloneJson(value: unknown, path: string, ancestors: Set<object>): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (Number.isFinite(value) && !Object.is(value, -0)) return value;
    throw new TypeError(
      `Cannot serialize ${path}: expected a finite JSON number without negative zero`,
    );
  }
  if (typeof value !== "object")
    throw new TypeError(`Cannot serialize ${path}: unsupported ${typeof value} value`);
  if (ancestors.has(value)) throw new TypeError(`Cannot serialize ${path}: cyclic value`);
  const array = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (!array && prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`Cannot serialize ${path}: expected a plain JSON object`);
  }
  ancestors.add(value);
  try {
    const result: JsonValue[] | Record<string, JsonValue> = array ? [] : Object.create(null);
    const keys = Reflect.ownKeys(value);
    if (array && keys.length !== value.length + 1) {
      throw new TypeError(
        `Cannot serialize ${path}: sparse arrays and extra array properties are unsupported`,
      );
    }
    for (const key of keys) {
      if (array && key === "length") continue;
      if (typeof key !== "string")
        throw new TypeError(`Cannot serialize ${path}: symbol keys are unsupported`);
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (!descriptor.enumerable || !("value" in descriptor)) {
        throw new TypeError(
          `Cannot serialize ${path}.${key}: accessors and non-enumerable properties are unsupported`,
        );
      }
      if (array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)) {
        throw new TypeError(`Cannot serialize ${path}: extra array properties are unsupported`);
      }
      (result as Record<string, JsonValue>)[key] = cloneJson(
        descriptor.value,
        `${path}.${key}`,
        ancestors,
      );
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}
