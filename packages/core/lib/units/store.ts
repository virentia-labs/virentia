import { createNode, run } from "../kernel";
import type { Node } from "../kernel";
import {
  prepareInspectorSnapshotNode,
  readInspectorNodeMeta,
  withInspectorMeta,
} from "../kernel/inspector";
import { getActiveScope, requireActiveScope, setActiveScope } from "../scope/internal";
import type { Scope } from "../scope";
import { collectNodes, trackNode } from "../graph/deps";
import { registerCleanup } from "../graph/owner";

const defaultSkipToken = Symbol("virentia.skip");
const committedStoreUpdate = Symbol("virentia.committedStoreUpdate");
const storeReaders = new WeakMap<object, () => unknown>();

export type StoreView<T> = T extends object ? Readonly<T> : { readonly value: T };

export type StoreWrite<T> = T extends object ? T : { value: T };

export type StoreSubscriber<T> = (value: T, scope: Scope) => void;
export interface StoreDevtoolsOptions {
  name?: string;
}

export type Store<T> = StoreView<T> & StoreApi<T>;
export type StoreWritable<T> = StoreWrite<T> &
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

interface StoreOptions<T> {
  writable: boolean;
  skipToken?: T;
  hasSkipToken: boolean;
  name?: string;
}

interface ComputedOptions<T> extends Omit<StoreOptions<T>, "writable"> {
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
    skipToken,
    hasSkipToken: arguments.length > 1 && !(arguments.length === 3 && skipToken === undefined),
    name: devtools?.name,
  }) as StoreWritable<T>;
}

export function readStoreValue<T>(store: Store<T>): T {
  const reader = storeReaders.get(store as object);

  if (!reader) {
    throw new Error("Unknown store");
  }

  return reader() as T;
}

export function readonlyStore<T>(
  initial: T,
  skipToken?: T,
  devtools?: StoreDevtoolsOptions,
): Store<T> {
  return createStore(initial, {
    writable: false,
    skipToken,
    hasSkipToken: arguments.length > 1 && !(arguments.length === 3 && skipToken === undefined),
    name: devtools?.name,
  });
}

export function computed<T>(fn: () => T, skipToken?: T, devtools?: StoreDevtoolsOptions): Store<T> {
  return createComputed(fn, {
    skipToken,
    hasSkipToken: arguments.length > 1 && !(arguments.length === 3 && skipToken === undefined),
    name: devtools?.name,
  });
}

function createStore<T>(initial: T, options: StoreOptions<T>): Store<T> {
  const id = Symbol("virentia.store");
  const subscribers = new Set<StoreSubscriber<T>>();
  const node = createNode({
    meta: withInspectorMeta(undefined, {
      type: "store",
      name: options.name,
      callable: true,
      writable: options.writable,
    }),
    run: (ctx) => {
      if (!ctx.scope) {
        throw new Error("Store update requires scope");
      }

      const value = ctx.value;

      if (isCommittedStoreUpdate<T>(value)) {
        return value.value;
      }

      const next = value as T;

      if (options.hasSkipToken && Object.is(next, options.skipToken)) {
        ctx.stop();
        return readState(ctx.scope, id, initial);
      }

      const previous = readState(ctx.scope, id, initial);

      if (Object.is(previous, next)) {
        ctx.stop();
        return previous;
      }

      ctx.scope.values.set(id, next);

      for (const subscriber of subscribers) {
        subscriber(next, ctx.scope);
      }

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
        () => fn(readState(requireActiveScope(), id, initial)),
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
          const value = readState(requireActiveScope(), id, initial);

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
        () => fn(readState(requireActiveScope(), id, initial)),
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

  storeReaders.set(proxy as object, () => readState(requireActiveScope(), id, initial));

  return proxy as Store<T>;

  function readStateForProxy(): T {
    trackNode(node);

    return readState(requireActiveScope(), id, initial);
  }

  function writeProperty(property: PropertyKey, value: unknown): boolean {
    const scope = requireActiveScope();
    const state = readState(scope, id, initial);

    if (!isObject(state) && property !== "value") {
      throw new Error("Primitive store value must be written through .value");
    }

    const next = isObject(state) ? assignProperty(state, property, value) : (value as T);

    if (options.hasSkipToken && Object.is(next, options.skipToken)) {
      return true;
    }

    if (Object.is(state, next)) {
      return true;
    }

    scope.values.set(id, next);

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

    return true;
  }
}

function createComputed<T>(
  fn: () => T,
  options: ComputedOptions<T>,
  initialDependencies: readonly Node[] = [],
): Store<T> {
  const id = Symbol("virentia.computed");
  const subscribers = new Set<StoreSubscriber<T>>();
  const dependencies = new Set<Node>();
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

      if (!hasObservers()) {
        ctx.stop();
      }

      return ctx.value;
    },
  });
  const node = createNode({
    meta: withInspectorMeta(undefined, {
      type: "computed",
      name: options.name,
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
    attachDependency(dependency);
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
  const proxy = new Proxy(api, createStoreProxyHandlers({ writable: false }, readComputed));

  storeReaders.set(proxy as object, readComputed);

  return proxy as Store<T>;

  function hasObservers(): boolean {
    return subscribers.size > 0 || Boolean(node.next?.length);
  }

  function readComputed(): T {
    trackNode(node);

    const scope = requireActiveScope();

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

      for (const dependency of collected.nodes) {
        attachDependency(dependency);
      }

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

  function inspectDependencies(): void {
    const previousScope = getActiveScope();

    setActiveScope({
      values: new Map(),
    });

    try {
      const collected = collectNodes(fn);

      for (const dependency of collected.nodes) {
        attachDependency(dependency);
      }
    } catch {
      // Inspector snapshots should not make user code fail because a lazy computed cannot be inspected.
    } finally {
      setActiveScope(previousScope);
    }
  }

  function attachDependency(dependency: Node): void {
    if (dependency === node || dependencies.has(dependency)) {
      return;
    }

    append(dependency, invalidator);
    dependencies.add(dependency);
  }
}

function createStoreProxyHandlers<T>(
  options: Pick<StoreOptions<T>, "writable">,
  read: () => T,
  write?: (property: PropertyKey, value: unknown) => boolean,
): ProxyHandler<StoreApi<T>> {
  return {
    get(target, property, receiver) {
      if (property in target) {
        return Reflect.get(target, property, receiver);
      }

      const state = read();

      if (isObject(state)) {
        return Reflect.get(state, property);
      }

      if (property === "value") {
        return state;
      }

      return undefined;
    },

    set(target, property, value) {
      if (property in target) {
        return false;
      }

      if (!options.writable) {
        throw new Error("Store is read-only");
      }

      return write ? write(property, value) : false;
    },

    has(target, property) {
      if (property in target) return true;

      const state = read();

      return isObject(state) && property in state;
    },

    ownKeys(target) {
      const state = read();
      const stateKeys = isObject(state) ? Reflect.ownKeys(state) : ["value"];

      return [...Reflect.ownKeys(target), ...stateKeys];
    },

    getOwnPropertyDescriptor(target, property) {
      if (property in target) {
        return Reflect.getOwnPropertyDescriptor(target, property);
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
  if (!scope.values.has(id)) {
    scope.values.set(id, initial);
  }

  return scope.values.get(id) as T;
}

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
