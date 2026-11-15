import { computed } from "@virentia/core";
import type { Node, Scope, Store, StoreDevtoolsOptions } from "@virentia/core";
import {
  node,
  isTracking,
  requireActiveScope,
  run,
  trackScopedRead,
  unwrapMicroScope,
  writeTransactionStore,
  trackStoreDeclaration,
  sequenceBinding,
  type SequenceBinding,
  type SequenceOperation,
  materializeSnapshotStore,
  resolveStoreSid,
} from "@virentia/core/internal";
import type { StoreCommitResult } from "@virentia/core/internal";
import { createRootDraft, unwrap } from "./draft";
import type { Draft, DraftEnv } from "./draft";

/**
 * A store whose `.value` is a **deeply mutable** object.
 *
 * Mutate it directly — `state.value.a.items.push(x)`, `state.value.count++`,
 * `delete state.value.a.flag` — or replace it wholesale (`state.value = next`).
 * Changes go to a copy-on-write draft (no `structuredClone`, no snapshots): only
 * touched nodes are copied, untouched branches stay shared, and the committed
 * value is untouched until the transaction boundary. At commit the draft becomes
 * the scope's value and a notification re-runs everything that read the store
 * (`computed`, auto reactions, `subscribe`, `map`).
 *
 * Only plain objects and arrays are tracked deeply; `Date`, `Map`, `Set`, and
 * class instances are leaves — replace them wholesale.
 */
export interface MutableStore<T> {
  readonly node: Node;
  readonly writable: true;
  readonly sid?: string;
  /** A deeply-mutable draft over the state; set to replace it wholesale. */
  value: T;
  subscribe(fn: (value: T, scope: Scope) => void): () => void;
  map<U>(fn: (value: T) => U): Store<U>;
  readonly [sequenceBinding]?: SequenceBinding<T extends readonly (infer Item)[] ? Item : unknown>;
}

const noop = (): void => {};
const COMMIT_MARKER = Symbol("virentia.mutable.commit");

const seeders = new WeakMap<object, (scope: Scope, value: unknown) => void>();

export function mutableStore<T extends object>(
  initial: T,
  options?: StoreDevtoolsOptions,
): MutableStore<T> {
  const baseId = Symbol("virentia.store");
  const commitId = Symbol("virentia.mutable.commit");
  // The coarse node: fired on every commit. It drives `subscribe` consumers
  // (`useUnit` on the whole store), explicit `on: store` reactions, and whole-
  // value reads (`unwrap`). Fine-grained readers subscribe to path nodes instead.
  const storeNode = node({ run: (ctx) => ctx.value });
  const sid = resolveStoreSid(options?.sid);
  const snapshotStore = sid === undefined ? undefined : { sid, id: baseId, identity: storeNode };
  const subscribers = new Set<(value: T, scope: Scope) => void>();

  // Keypath -> graph node, created lazily the first time a reader touches that
  // path. A read `trackNode`s the path node; a commit fires only the path nodes
  // whose paths changed, so a computed/reaction re-runs only for the parts it read.
  const pathNodes = new Map<string, Node>();
  const pathNodeFor = (path: string): Node => {
    let pathNode = pathNodes.get(path);
    if (!pathNode) {
      pathNode = node({ resolveScope: storeNode.resolveScope, run: (ctx) => ctx.value });
      pathNodes.set(path, pathNode);
    }
    return pathNode;
  };

  // Per scope: nodes this scope already owns (copies it made — mutate in place
  // instead of copying again), the live draft for the current transaction, the
  // draft env, the set of keypaths changed this transaction, whether a wholesale
  // replace happened (invalidates every path), and whether anything changed.
  const ownedByScope = new WeakMap<Scope, WeakSet<object>>();
  const draftByScope = new WeakMap<Scope, Draft>();
  const draftBases = new WeakMap<Scope, T>();
  const envByScope = new WeakMap<Scope, DraftEnv>();
  const changedByScope = new WeakMap<Scope, Set<string>>();
  const replacedScopes = new WeakSet<Scope>();
  const dirtyScopes = new WeakSet<Scope>();
  const sequences = new WeakMap<Scope, Map<string, SequenceBinding>>();
  const sequenceListeners = new WeakMap<Scope, Map<string, Set<(operations: readonly SequenceOperation<unknown>[]) => void>>>();
  const sequenceEdits = new WeakMap<Scope, Map<string, SequenceOperation<unknown>[]>>();
  const editedArrays = new WeakMap<Scope, Set<string>>();
  const separator = "\u0001";

  const arrayAt = (scope: Scope, path: string): unknown[] => {
    let value: unknown = draftFor(scope).proxy;
    for (const key of path.split(separator).filter(Boolean)) value = (value as Record<string, unknown>)[key];
    if (!Array.isArray(value)) throw new TypeError("[mutable] Sequence source is no longer an array");
    return Array.from(value);
  };
  const editsAt = (scope: Scope, path: string): SequenceOperation<unknown>[] => {
    let paths = sequenceEdits.get(scope);
    if (!paths) sequenceEdits.set(scope, paths = new Map());
    let edits = paths.get(path);
    if (!edits) paths.set(path, edits = []);
    return edits;
  };
  const sequenceAt = (scope: Scope, path: string): SequenceBinding => {
    let paths = sequences.get(scope);
    if (!paths) sequences.set(scope, paths = new Map());
    let binding = paths.get(path);
    if (!binding) {
      binding = {
        scope,
        snapshot: () => arrayAt(scope, path),
        subscribe(listener) {
          let paths = sequenceListeners.get(scope);
          if (!paths) sequenceListeners.set(scope, paths = new Map());
          let listeners = paths.get(path);
          if (!listeners) paths.set(path, listeners = new Set());
          listeners.add(listener);
          return () => {
            listeners!.delete(listener);
            if (!listeners!.size) paths!.delete(path);
          };
        },
      };
      paths.set(path, binding);
    }
    return binding;
  };

  const changedOf = (scope: Scope): Set<string> => {
    let changed = changedByScope.get(scope);
    if (!changed) {
      changed = new Set();
      changedByScope.set(scope, changed);
    }
    return changed;
  };

  // Unwrap a reaction run's micro-scope overlay: drafts, ownership, and the
  // scope handed to subscribers must all key by the real scope — a micro-scope's
  // identity dies with the run, and subscribers compare identities (useUnit).
  const scopeOf = (verb: string): Scope => {
    const active = requireActiveScope(() => `${verb} a mutable store`);
    return unwrapMicroScope(storeNode.resolveScope?.(active) ?? active);
  };

  // The scope's committed value — the shared `initial` until the scope first
  // diverges (copy-on-write), never eagerly cloned.
  const committed = (scope: Scope): T => {
    if (snapshotStore) materializeSnapshotStore(scope, snapshotStore);
    return (scope.values.get(baseId) as T | undefined) ?? initial;
  };

  const ownedOf = (scope: Scope): WeakSet<object> => {
    let owned = ownedByScope.get(scope);
    if (!owned) {
      owned = new WeakSet();
      ownedByScope.set(scope, owned);
    }
    return owned;
  };

  // Nothing is written to `scope.values` until here: the whole change (mutations
  // and/or a wholesale replace) is applied atomically at the transaction
  // boundary (immediately for a plain `scoped(...)` change, batched inside a
  // reaction/effect).
  const finalize = (scope: Scope): StoreCommitResult => {
    const draft = draftByScope.get(scope);
    const changed = dirtyScopes.has(scope);
    const changedPaths = changedByScope.get(scope);
    const replaced = replacedScopes.has(scope);
    const edits = sequenceEdits.get(scope);

    draftByScope.delete(scope);
    dirtyScopes.delete(scope);
    changedByScope.delete(scope);
    replacedScopes.delete(scope);
    sequenceEdits.delete(scope);
    editedArrays.delete(scope);

    if (!draft || !changed) return { changed: false, notify: noop };

    const next = draft.latest() as T;
    scope.values.set(baseId, next);

    return {
      changed: true,
      notify: () => {
        for (const [path, listeners] of sequenceListeners.get(scope) ?? []) {
          const operations = replaced ? [{ type: "reset" as const, items: arrayAt(scope, path) }] : edits?.get(path);
          if (operations?.length) for (const listener of [...listeners]) listener(operations);
        }
        for (const subscriber of subscribers) subscriber(next, scope);
        // Coarse fire: whole-value readers and explicit `on: store` reactions.
        void run({ unit: storeNode, payload: next, scope });

        if (replaced) {
          // A wholesale replace may change any path — fire every live path node.
          for (const pathNode of pathNodes.values()) {
            void run({ unit: pathNode, payload: next, scope });
          }
        } else if (changedPaths) {
          // Fine fire: only readers of a path that actually changed re-run.
          for (const path of changedPaths) {
            const pathNode = pathNodes.get(path);
            if (pathNode) void run({ unit: pathNode, payload: next, scope });
          }
        }
      },
    };
  };

  const markChanged = (scope: Scope): void => {
    dirtyScopes.add(scope);
    writeTransactionStore({ id: commitId, scope, commit: () => finalize(scope) }, COMMIT_MARKER);
  };

  const envFor = (scope: Scope): DraftEnv => {
    let env = envByScope.get(scope);
    if (!env) {
      env = {
        owned: ownedOf(scope),
        onChange: (path, kind) => {
          changedOf(scope).add(path);
          for (const streamPath of sequenceListeners.get(scope)?.keys() ?? []) {
            if (path === streamPath) {
              if (kind !== "array") editsAt(scope, streamPath).push({ type: "reset", items: arrayAt(scope, streamPath) });
            } else if (path.startsWith(streamPath + separator)) {
              const relative = path.slice(streamPath.length + separator.length).split(separator);
              if (/^(0|[1-9][0-9]*)$/.test(relative[0]) && relative.length > 1) {
                const index = Number(relative[0]);
                editsAt(scope, streamPath).push({ type: "update", index, item: arrayAt(scope, streamPath)[index] });
              }
            }
          }
          markChanged(scope);
        },
        sequenceAt: (path) => sequenceAt(scope, path),
        onArrayChange(path, operations) {
          let paths = editedArrays.get(scope);
          if (!paths) editedArrays.set(scope, paths = new Set());
          paths.add(path);
          editsAt(scope, path).push(...operations);
        },
        onRead: (path) => trackScopedRead(pathNodeFor(path), requireActiveScope(), scope),
        onReadAll: () => trackScopedRead(storeNode, requireActiveScope(), scope),
        isTracking,
      };
      envByScope.set(scope, env);
    }
    return env;
  };

  const draftFor = (scope: Scope): Draft => {
    let draft = draftByScope.get(scope);
    if (draft && !dirtyScopes.has(scope) && draftBases.get(scope) !== committed(scope)) draft = undefined;
    if (!draft) {
      const base = committed(scope);
      draft = createRootDraft(base, envFor(scope));
      draftBases.set(scope, base);
      draftByScope.set(scope, draft);
    }
    return draft;
  };

  // Read of the current value. Reactivity is registered per keypath by the draft
  // proxy's read hooks (see `draft.ts`), so a reader only subscribes to the parts
  // it actually touches. Sees the draft's latest during a transaction.
  const readTracked = (): T => draftFor(scopeOf("read")).proxy as T;

  const self: MutableStore<T> = {
    node: storeNode,
    writable: true,
    sid,
    get [sequenceBinding]() {
      const scope = scopeOf("read");
      return Array.isArray(committed(scope)) ? sequenceAt(scope, "") as never : undefined;
    },

    get value(): T {
      return draftFor(scopeOf("read")).proxy as T;
    },

    set value(next: T) {
      const scope = scopeOf("write");
      // Deferred wholesale replace: open a fresh draft over `next` and mark the
      // scope changed (and every path stale). `next` itself is not mutated
      // (copy-on-write on descent); nothing commits until the transaction boundary.
      draftByScope.set(scope, createRootDraft(unwrap(next), envFor(scope)));
      replacedScopes.add(scope);
      markChanged(scope);
    },

    subscribe(fn: (value: T, scope: Scope) => void) {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },

    map<U>(fn: (value: T) => U): Store<U> {
      return computed(() => fn(readTracked()));
    },
  };

  // Seeding writes the base directly for a scope (the store then owns and mutates
  // that value in place) through the private base key.
  seeders.set(self, (scope, value) => {
    draftByScope.delete(scope);
    scope.values.set(baseId, value);
    ownedOf(scope).add(value as object);
  });
  trackStoreDeclaration({ id: baseId, identity: storeNode, sid });

  return self;
}

/**
 * Provide a mutable store's initial value for a scope (SSR hydration, tests,
 * previews). The scope then owns and mutates that value in place.
 */
export function seedMutableStore<T extends object>(
  scope: Scope,
  store: MutableStore<T>,
  value: T,
): void {
  const seed = seeders.get(store);
  if (!seed) throw new Error("seedMutableStore: not a mutable store");
  seed(scope, value);
}
