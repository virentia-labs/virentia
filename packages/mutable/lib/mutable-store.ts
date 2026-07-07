import { computed } from "@virentia/core";
import type { Node, Scope, Store, StoreDevtoolsOptions } from "@virentia/core";
import {
  node,
  isTracking,
  requireActiveScope,
  run,
  trackNode,
  writeTransactionStore,
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
  /** A deeply-mutable draft over the state; set to replace it wholesale. */
  value: T;
  subscribe(fn: (value: T, scope: Scope) => void): () => void;
  map<U>(fn: (value: T) => U): Store<U>;
}

const noop = (): void => {};
const COMMIT_MARKER = Symbol("virentia.mutable.commit");

const seeders = new WeakMap<object, (scope: Scope, value: unknown) => void>();

export function mutableStore<T extends object>(
  initial: T,
  _options?: StoreDevtoolsOptions,
): MutableStore<T> {
  const baseId = Symbol("virentia.mutable.base");
  const commitId = Symbol("virentia.mutable.commit");
  // The coarse node: fired on every commit. It drives `subscribe` consumers
  // (`useUnit` on the whole store), explicit `on: store` reactions, and whole-
  // value reads (`unwrap`). Fine-grained readers subscribe to path nodes instead.
  const storeNode = node({ run: (ctx) => ctx.value });
  const subscribers = new Set<(value: T, scope: Scope) => void>();

  // Keypath -> graph node, created lazily the first time a reader touches that
  // path. A read `trackNode`s the path node; a commit fires only the path nodes
  // whose paths changed, so a computed/reaction re-runs only for the parts it read.
  const pathNodes = new Map<string, Node>();
  const pathNodeFor = (path: string): Node => {
    let pathNode = pathNodes.get(path);
    if (!pathNode) {
      pathNode = node({ run: (ctx) => ctx.value });
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
  const envByScope = new WeakMap<Scope, DraftEnv>();
  const changedByScope = new WeakMap<Scope, Set<string>>();
  const replacedScopes = new WeakSet<Scope>();
  const dirtyScopes = new WeakSet<Scope>();

  const changedOf = (scope: Scope): Set<string> => {
    let changed = changedByScope.get(scope);
    if (!changed) {
      changed = new Set();
      changedByScope.set(scope, changed);
    }
    return changed;
  };

  const scopeOf = (verb: string): Scope => requireActiveScope(() => `${verb} a mutable store`);

  // The scope's committed value — the shared `initial` until the scope first
  // diverges (copy-on-write), never eagerly cloned.
  const committed = (scope: Scope): T => (scope.values.get(baseId) as T | undefined) ?? initial;

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

    draftByScope.delete(scope);
    dirtyScopes.delete(scope);
    changedByScope.delete(scope);
    replacedScopes.delete(scope);

    if (!draft || !changed) return { changed: false, notify: noop };

    const next = draft.latest() as T;
    scope.values.set(baseId, next);

    return {
      changed: true,
      notify: () => {
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
        onChange: (path) => {
          changedOf(scope).add(path);
          markChanged(scope);
        },
        onRead: (path) => trackNode(pathNodeFor(path)),
        onReadAll: () => trackNode(storeNode),
        isTracking,
      };
      envByScope.set(scope, env);
    }
    return env;
  };

  const draftFor = (scope: Scope): Draft => {
    let draft = draftByScope.get(scope);
    if (!draft) {
      draft = createRootDraft(committed(scope), envFor(scope));
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
