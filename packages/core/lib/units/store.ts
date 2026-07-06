import { createNode, run } from "../kernel";
import type { Node } from "../kernel";
import {
  isPendingStoreValue,
  readTransactionStore,
  withTransaction,
  writeTransactionStore,
} from "../kernel/transaction";
import type { StoreCommitResult } from "../kernel/transaction";
import {
  describeNode,
  linkInspectorNodes,
  prepareInspectorSnapshotNode,
  readInspectorNodeMeta,
  withInspectorMeta,
} from "../kernel/inspector";
import { getScopedObservers, reconcileScopedEdges } from "../kernel/scoped-edges";
import { unwrapMicroScope } from "../scope/micro";
import { requireActiveScope, setActiveScope } from "../scope/internal";
import type { Scope } from "../scope";
import { collectNodes, trackNode } from "../graph/deps";
import { registerCleanup } from "../graph/owner";

const defaultSkipToken = Symbol("virentia.skip");
const committedStoreUpdate = Symbol("virentia.committedStoreUpdate");
const storeReaders = new WeakMap<object, () => unknown>();
const storeScopeWriters = new WeakMap<object, (scope: Scope, value: unknown) => void>();

// A `store` is always accessed through `.value`, regardless of whether it holds
// a primitive or an object. For direct field access on object state use `reactive`.
export type StoreView<T> = { readonly value: T };

export type StoreWrite<T> = { value: T };

// A `reactive` exposes the object state directly: fields are read and written on
// the unit itself, without a `.value` indirection.
export type ReactiveView<T> = Readonly<T>;

export type ReactiveWrite<T> = T;

export type StoreSubscriber<T> = (value: T, scope: Scope) => void;
export interface StoreDevtoolsOptions {
  name?: string;
  key?: boolean;
}

export type Store<T> = StoreView<T> & StoreApi<T>;
export type StoreWritable<T> = StoreWrite<T> &
  StoreApi<T> & {
    readonly writable: true;
  };

export type Reactive<T> = ReactiveView<T> & StoreApi<T>;
export type ReactiveWritable<T> = ReactiveWrite<T> &
  StoreApi<T> & {
    readonly writable: true;
  };

export interface StoreApi<T> {
  readonly node: Node;
  readonly writable: boolean;
  subscribe(fn: StoreSubscriber<T>): () => void;
  map<Next>(fn: (value: T) => Next, skipToken?: Next): Store<Next>;
  filter(fn: (value: T) => boolean): Store<T>;
  filterMap<Next>(fn: (value: T) => Next, skipToken: Next): Store<Next>;
}

type StoreMode = "ref" | "reactive";

interface StoreOptions<T> {
  writable: boolean;
  mode: StoreMode;
  skipToken?: T;
  hasSkipToken: boolean;
  name?: string;
  key?: boolean;
}

interface ComputedOptions<T> extends Omit<StoreOptions<T>, "writable" | "mode"> {
  initialValue?: T;
  hasInitialValue?: boolean;
}

interface ComputedState<T> {
  computing: boolean;
  dirty: boolean;
  initialized: boolean;
  skipped: boolean;
  value?: T;
}

export function store<T>(
  initial: T,
  skipToken?: T,
  devtools?: StoreDevtoolsOptions,
): StoreWritable<T> {
  return createStore(initial, {
    writable: true,
    mode: "ref",
    skipToken,
    hasSkipToken: arguments.length > 1 && !(arguments.length === 3 && skipToken === undefined),
    name: devtools?.name,
    key: devtools?.key,
  }) as StoreWritable<T>;
}

export function readStoreValue<T>(store: Store<T>): T {
  const reader = storeReaders.get(store as object);

  if (!reader) {
    throw new Error("Unknown store");
  }

  return reader() as T;
}

export function seedScopeStoreValue<T>(scope: Scope, store: StoreWritable<T>, value: T): void {
  const writer = storeScopeWriters.get(store as object);

  if (!writer) {
    throw new Error("Scope values can contain only writable stores");
  }

  writer(scope, value);
}

export function readonlyStore<T>(
  initial: T,
  skipToken?: T,
  devtools?: StoreDevtoolsOptions,
): Store<T> {
  return createStore(initial, {
    writable: false,
    mode: "ref",
    skipToken,
    hasSkipToken: arguments.length > 1 && !(arguments.length === 3 && skipToken === undefined),
    name: devtools?.name,
    key: devtools?.key,
  });
}

export function reactive<T extends object>(
  initial: T,
  skipToken?: T,
  devtools?: StoreDevtoolsOptions,
): ReactiveWritable<T> {
  return createStore(initial, {
    writable: true,
    mode: "reactive",
    skipToken,
    hasSkipToken: arguments.length > 1 && !(arguments.length === 3 && skipToken === undefined),
    name: devtools?.name,
    key: devtools?.key,
  }) as unknown as ReactiveWritable<T>;
}

export function readonlyReactive<T extends object>(
  initial: T,
  skipToken?: T,
  devtools?: StoreDevtoolsOptions,
): Reactive<T> {
  return createStore(initial, {
    writable: false,
    mode: "reactive",
    skipToken,
    hasSkipToken: arguments.length > 1 && !(arguments.length === 3 && skipToken === undefined),
    name: devtools?.name,
    key: devtools?.key,
  }) as unknown as Reactive<T>;
}

export function computed<T>(fn: () => T, skipToken?: T, devtools?: StoreDevtoolsOptions): Store<T> {
  return createComputed(fn, {
    skipToken,
    hasSkipToken: arguments.length > 1 && !(arguments.length === 3 && skipToken === undefined),
    name: devtools?.name,
    key: devtools?.key,
  });
}

function createStore<T>(initial: T, options: StoreOptions<T>): Store<T> {
  const id = Symbol("virentia.store");
  const subscribers = new Set<StoreSubscriber<T>>();
  const node = createNode({
    meta: withInspectorMeta(undefined, {
      type: "store",
      name: options.name,
      key: options.key,
      callable: true,
      writable: options.writable,
    }),
    run: (ctx) => {
      if (!ctx.scope) {
        throw new Error("Store update requires scope");
      }

      const scope = ctx.scope;
      const value = ctx.value;

      if (isCommittedStoreUpdate<T>(value)) {
        return value.value;
      }

      const next = value as T;

      if (options.hasSkipToken && Object.is(next, options.skipToken)) {
        ctx.stop();
        return readState(ctx.scope, id, initial);
      }

      const previous = readCommittedState(scope, id, initial);

      if (Object.is(previous, next)) {
        ctx.stop();
        return previous;
      }

      commitImmediateState(scope, next);

      return next;
    },
  });

  const api: StoreApi<T> = {
    node,
    writable: options.writable,

    subscribe(fn: StoreSubscriber<T>): () => void {
      subscribers.add(fn);

      const unsubscribe = () => {
        subscribers.delete(fn);
      };

      const unregisterCleanup = registerCleanup(unsubscribe);

      return () => {
        unregisterCleanup();
        unsubscribe();
      };
    },

    map<Next>(fn: (value: T) => Next, skipToken?: Next): Store<Next> {
      return createComputed(
        () =>
          fn(
            readState(
              requireActiveScope(() => `read ${describeNode(node)}`),
              id,
              initial,
            ),
          ),
        {
          skipToken,
          hasSkipToken: arguments.length > 1,
          name: deriveName(node, "map"),
        },
        [node],
      );
    },

    filter(fn: (value: T) => boolean): Store<T> {
      return createComputed(
        () => {
          const value = readState(
            requireActiveScope(() => `read ${describeNode(node)}`),
            id,
            initial,
          );

          return fn(value) ? value : (defaultSkipToken as T);
        },
        {
          skipToken: defaultSkipToken as T,
          hasSkipToken: true,
          initialValue: initial,
          hasInitialValue: true,
          name: deriveName(node, "filter"),
        },
        [node],
      );
    },

    filterMap<Next>(fn: (value: T) => Next, skipToken: Next): Store<Next> {
      return createComputed(
        () =>
          fn(
            readState(
              requireActiveScope(() => `read ${describeNode(node)}`),
              id,
              initial,
            ),
          ),
        {
          skipToken,
          hasSkipToken: true,
          name: deriveName(node, "filterMap"),
        },
        [node],
      );
    },
  };

  const proxy = new Proxy(
    api,
    createStoreProxyHandlers(options, () => readStateForProxy(), writeProperty),
  );

  storeReaders.set(proxy as object, () =>
    readState(
      requireActiveScope(() => `read ${describeNode(node)}`),
      id,
      initial,
    ),
  );
  if (options.writable) {
    storeScopeWriters.set(proxy as object, (scope, value) => {
      scope.values.set(id, value);
    });
  }

  return proxy as Store<T>;

  function readStateForProxy(): T {
    trackNode(node);

    return readState(
      requireActiveScope(() => `read ${describeNode(node)}`),
      id,
      initial,
    );
  }

  function writeProperty(property: PropertyKey, value: unknown): boolean {
    const scope = requireActiveScope(() => `update ${describeNode(node)}`);
    const state = readState(scope, id, initial);

    // In "ref" mode the proxy `set` trap guarantees `property === "value"`, so the
    // whole value is replaced. In "reactive" mode a single field is updated.
    const next =
      options.mode === "reactive" ? assignProperty(state, property, value) : (value as T);

    if (options.hasSkipToken && Object.is(next, options.skipToken)) {
      return true;
    }

    if (Object.is(state, next)) {
      return true;
    }

    withTransaction(() => {
      writeTransactionStore(
        {
          id,
          scope,
          commit: (value) => commitState(scope, value),
        },
        next,
      );
    });

    return true;
  }

  function commitState(scope: Scope, next: T): StoreCommitResult {
    if (options.hasSkipToken && Object.is(next, options.skipToken)) {
      return {
        changed: false,
        notify: noop,
      };
    }

    const previous = readCommittedState(scope, id, initial);

    if (Object.is(previous, next)) {
      return {
        changed: false,
        notify: noop,
      };
    }

    scope.values.set(id, next);

    return {
      changed: true,
      notify() {
        for (const subscriber of subscribers) {
          subscriber(next, scope);
        }

        void run({
          unit: node,
          payload: {
            [committedStoreUpdate]: true,
            value: next,
          },
          scope,
          batchKey: id,
        });
      },
    };
  }

  function commitImmediateState(scope: Scope, next: T): void {
    scope.values.set(id, next);

    for (const subscriber of subscribers) {
      subscriber(next, scope);
    }
  }
}

function createComputed<T>(
  fn: () => T,
  options: ComputedOptions<T>,
  initialDependencies: readonly Node[] = [],
): Store<T> {
  const id = Symbol("virentia.computed");
  const subscribers = new Set<StoreSubscriber<T>>();
  // Structural deps known at creation (e.g. a `.map` source) are always deps in
  // every scope, so they stay global. Deps discovered while evaluating are
  // data-dependent and tracked per-scope, so a computed that reads different
  // stores in different scopes is invalidated precisely rather than from a
  // global union of every scope's branches.
  const staticDependencies = new Set<Node>();
  const invalidator = createNode({
    meta: withInspectorMeta(undefined, {
      type: "computed.invalidate",
      name: options.name ? `${options.name}.invalidate` : undefined,
      internal: true,
    }),
    run: (ctx) => {
      if (!ctx.scope) {
        throw new Error("Computed invalidation requires scope");
      }

      const state = readComputedState<T>(ctx.scope, id);

      state.dirty = true;

      if (!hasObservers(ctx.scope)) {
        ctx.stop();
      }

      return ctx.value;
    },
  });
  const node = createNode({
    meta: withInspectorMeta(undefined, {
      type: "computed",
      name: options.name,
      key: options.key,
    }),
    run: (ctx) => {
      if (!ctx.scope) {
        throw new Error("Computed update requires scope");
      }

      const state = readComputedState<T>(ctx.scope, id);
      const hadValue = state.initialized;
      const previous = state.value;
      const next = evaluate(ctx.scope, state);

      if (state.skipped || (hadValue && Object.is(previous, next))) {
        ctx.stop();
        return previous;
      }

      for (const subscriber of subscribers) {
        subscriber(next, ctx.scope);
      }

      return next;
    },
  });

  invalidator.next = [node];
  prepareInspectorSnapshotNode(node, inspectDependencies);

  for (const dependency of initialDependencies) {
    attachStaticDependency(dependency);
  }

  const api: StoreApi<T> = {
    node,
    writable: false,

    subscribe(fn: StoreSubscriber<T>): () => void {
      subscribers.add(fn);

      const unsubscribe = () => {
        subscribers.delete(fn);
      };

      const unregisterCleanup = registerCleanup(unsubscribe);

      return () => {
        unregisterCleanup();
        unsubscribe();
      };
    },

    map<Next>(mapper: (value: T) => Next, skipToken?: Next): Store<Next> {
      return createComputed(
        () => mapper(readComputed()),
        {
          skipToken,
          hasSkipToken: arguments.length > 1,
          name: deriveName(node, "map"),
        },
        [node],
      );
    },

    filter(predicate: (value: T) => boolean): Store<T> {
      return createComputed(
        () => {
          const value = readComputed();

          return predicate(value) ? value : (defaultSkipToken as T);
        },
        {
          skipToken: defaultSkipToken as T,
          hasSkipToken: true,
          name: deriveName(node, "filter"),
        },
        [node],
      );
    },

    filterMap<Next>(mapper: (value: T) => Next, skipToken: Next): Store<Next> {
      return createComputed(
        () => mapper(readComputed()),
        {
          skipToken,
          hasSkipToken: true,
          name: deriveName(node, "filterMap"),
        },
        [node],
      );
    },
  };
  const proxy = new Proxy(
    api,
    createStoreProxyHandlers({ writable: false, mode: "ref" }, readComputed),
  );

  storeReaders.set(proxy as object, readComputed);

  return proxy as Store<T>;

  function hasObservers(scope: Scope | null): boolean {
    if (subscribers.size > 0 || Boolean(node.next?.length)) {
      return true;
    }

    // Reactions and other computeds may observe this computed per-scope (via
    // scoped edges) rather than through the static `node.next`, so an invalidation
    // must not stop just because there are no static observers.
    return scope ? (getScopedObservers(scope, node)?.size ?? 0) > 0 : false;
  }

  function readComputed(): T {
    trackNode(node);

    // Track (above) sees the micro-scope so the reading reaction depends on this
    // computed. The computed's own state/edges belong to the real scope — a
    // micro-scope is a throwaway per-run overlay, so edges there would be lost.
    const scope = unwrapMicroScope(requireActiveScope(() => `read ${describeNode(node)}`));

    return evaluate(scope, readComputedState<T>(scope, id));
  }

  function evaluate(scope: Scope, state: ComputedState<T>): T {
    if (state.initialized && !state.dirty) {
      return state.value as T;
    }

    if (state.computing) {
      throw new Error("Computed cycle detected");
    }

    state.computing = true;

    try {
      const collected = collectNodes(fn);

      reconcileDynamicDependencies(scope, collected.nodes);

      if (options.hasSkipToken && Object.is(collected.result, options.skipToken)) {
        if (!state.initialized) {
          state.value = options.hasInitialValue ? options.initialValue : (collected.result as T);
          state.initialized = true;
        }

        state.skipped = true;
        state.dirty = false;
        return state.value as T;
      }

      state.value = collected.result;
      state.initialized = true;
      state.skipped = false;
      state.dirty = false;

      return collected.result;
    } finally {
      state.computing = false;
    }
  }

  function reconcileDynamicDependencies(scope: Scope, collected: ReadonlySet<Node>): void {
    const dynamic = new Set<Node>();

    for (const dependency of collected) {
      if (dependency !== node && !staticDependencies.has(dependency)) {
        dynamic.add(dependency);
      }
    }

    reconcileScopedEdges(scope, invalidator, dynamic);
  }

  function inspectDependencies(): void {
    // Propagation edges are per-scope, so nothing global to attach. For the
    // inspector graph we still evaluate against a throwaway scope and register
    // inspector-only links (dependency → computed) that don't affect propagation.
    const previousScope = setActiveScope({
      values: new Map(),
      handlers: new Map(),
      deps: new Map(),
    });

    try {
      const collected = collectNodes(fn);

      for (const dependency of collected.nodes) {
        if (dependency !== node) {
          linkInspectorNodes(dependency, node, { kind: "reactive" });
        }
      }
    } catch {
      // Inspector snapshots should not make user code fail because a lazy computed cannot be inspected.
    } finally {
      setActiveScope(previousScope);
    }
  }

  function attachStaticDependency(dependency: Node): void {
    if (dependency === node || staticDependencies.has(dependency)) {
      return;
    }

    append(dependency, invalidator);
    staticDependencies.add(dependency);
  }
}

function createStoreProxyHandlers<T>(
  options: Pick<StoreOptions<T>, "writable" | "mode">,
  read: () => T,
  write?: (property: PropertyKey, value: unknown) => boolean,
): ProxyHandler<StoreApi<T>> {
  const { mode } = options;

  // Whether `property` is a state key exposed by the proxy (not a `StoreApi` member).
  const hasStateKey = (property: PropertyKey): boolean => {
    if (mode === "ref") {
      return property === "value";
    }

    const state = read();

    return isObject(state) && property in state;
  };

  return {
    get(target, property, receiver) {
      if (property in target) {
        return Reflect.get(target, property, receiver);
      }

      const state = read();

      if (mode === "ref") {
        return property === "value" ? state : undefined;
      }

      return isObject(state) ? Reflect.get(state, property) : undefined;
    },

    set(target, property, value) {
      if (property in target) {
        return false;
      }

      if (!options.writable) {
        throw new Error("Store is read-only");
      }

      if (mode === "ref" && property !== "value") {
        throw new Error("Store value must be written through .value");
      }

      return write ? write(property, value) : false;
    },

    has(target, property) {
      return property in target || hasStateKey(property);
    },

    ownKeys(target) {
      const stateKeys =
        mode === "ref" ? ["value"] : isObject(read()) ? Reflect.ownKeys(read() as object) : [];

      return [...Reflect.ownKeys(target), ...stateKeys];
    },

    getOwnPropertyDescriptor(target, property) {
      if (property in target) {
        return Reflect.getOwnPropertyDescriptor(target, property);
      }

      if (!hasStateKey(property)) {
        return undefined;
      }

      return {
        configurable: true,
        enumerable: true,
      };
    },
  };
}

function append(source: Node, next: Node): void {
  source.next = source.next ?? [];
  source.next.push(next);

  registerCleanup(() => {
    const nextNodes = source.next;
    if (!nextNodes) return;

    const index = nextNodes.indexOf(next);

    if (index >= 0) {
      nextNodes.splice(index, 1);
    }
  });
}

function readComputedState<T>(scope: Scope, id: symbol): ComputedState<T> {
  if (!scope.values.has(id)) {
    scope.values.set(id, {
      computing: false,
      dirty: true,
      initialized: false,
      skipped: false,
    } satisfies ComputedState<T>);
  }

  return scope.values.get(id) as ComputedState<T>;
}

function readState<T>(scope: Scope, id: symbol, initial: T): T {
  const pending = readTransactionStore<T>(scope, id);

  if (isPendingStoreValue(pending)) {
    return pending as T;
  }

  return readCommittedState(scope, id, initial);
}

function readCommittedState<T>(scope: Scope, id: symbol, initial: T): T {
  if (!scope.values.has(id)) {
    scope.values.set(id, initial);
  }

  return scope.values.get(id) as T;
}

function noop(): void {}

function assignProperty<T>(state: T, property: PropertyKey, value: unknown): T {
  if (Array.isArray(state)) {
    const next = state.slice();

    Reflect.set(next, property, value);

    return next as T;
  }

  return {
    ...(state as object),
    [property]: value,
  } as T;
}

function isObject(value: unknown): value is object {
  return (typeof value === "object" || typeof value === "function") && value !== null;
}

function isCommittedStoreUpdate<T>(
  value: unknown,
): value is { readonly [committedStoreUpdate]: true; value: T } {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { [committedStoreUpdate]?: true })[committedStoreUpdate] === true
  );
}

function deriveName(source: Node, operation: string): string | undefined {
  const name = readInspectorNodeMeta(source).name;

  return name ? `${name}.${operation}` : undefined;
}
