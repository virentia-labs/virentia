import {
  event,
  getCurrentScope,
  reaction,
  scope as createScope,
  scoped,
  withOwner,
  type EventCallable,
  type Owner,
  type ReactionRun,
  type Scope,
} from "@virentia/core";
import {
  bindEventToScope,
  captureScopeSnapshot,
  modelInstanceBindingOf,
  node,
  releaseStoreDeclaration,
  run,
  runDetached,
  trackNode,
  unwrapMicroScope,
  withSidScope,
  withStoreDeclarationTracker,
  type Node as ReactiveNode,
  type StoreDeclaration,
} from "@virentia/core/internal";
import {
  collection,
  collectModelFieldReads,
  isModelDefinition,
  isModelInstance,
  type AnyModel,
  type InstanceOf,
  type InstanceApi,
  type ModelFieldReadSource,
  type ModelDefinition,
} from "@virentia/core/models";
import { componentMetadataOf } from "./component";
import type {
  Child,
  Component,
  ComponentLifecycle,
  ComponentLifecycleEvent,
  ElementDescriptor,
} from "./types";

export const element = Symbol("virentia.ui.element");
export const list = Symbol("virentia.ui.list");
export const show = Symbol("virentia.ui.show");
export const provider = Symbol("virentia.ui.provider");
export const portal = Symbol("virentia.ui.portal");
export const foreign = Symbol("virentia.ui.foreign");
export const Fragment = Symbol("virentia.ui.fragment");

type Parent = Element | DocumentFragment;
type Props = Record<string, unknown>;
type Cleanup = () => void;
type MarkedElement = ElementDescriptor & { [element]: true };
interface MountTask {
  context: UIContext;
  callback: () => void | Cleanup;
  unregister: Cleanup;
  hydrateForeign: boolean;
}
export interface RootState {
  depth: number;
  mounts: MountTask[];
  errors: unknown[];
  pendingModels: Set<ComponentRecord>;
  server: boolean;
  serverSucceeded?: boolean;
  hydration?: HydrationState;
}
export interface UIContext {
  scope: Scope;
  owner: Owner;
  document?: Document;
  namespace: string;
  values: ReadonlyMap<symbol, () => unknown>;
  root: RootState;
  path: string;
  nextChild: number;
  nextId: number;
  /** Old branch owner during an atomic dynamic/Show replacement. */
  replacing?: Owner;
  /** Only set while a retained component's setup function is executing. */
  setup?: ComponentRecord;
}

interface ComponentModel extends InstanceApi {}

interface ComponentRecord {
  readonly model: ComponentModel;
  readonly setupOwner: Owner;
  readonly mounts: Array<() => void | Cleanup>;
  readonly unmounts: Cleanup[];
  readonly declarations: StoreDeclaration[];
  readonly lifecycle: ComponentLifecycle<Props>;
  readonly instanceScope: Scope;
  committed: boolean;
  props: Props;
  values: ReadonlyMap<symbol, () => unknown>;
  view?: Child;
  mounted?: Owner;
  disposing?: boolean;
}

const componentRecords = new WeakMap<object, ComponentRecord>();
const ownerParents = new WeakMap<Owner, Owner>();
interface HydrationState {
  active: boolean;
  failed: boolean;
  cursors: Map<Parent, Node | null>;
}
let activeContext: UIContext | undefined;
export const htmlNamespace = "http://www.w3.org/1999/xhtml";
export const svgNamespace = "http://www.w3.org/2000/svg";
export const mathNamespace = "http://www.w3.org/1998/Math/MathML";

/** JSX produces inert descriptions. Component code only runs during mounting. */
export function createElement<P extends object>(
  type: string | Component<P> | symbol,
  props?: P | null,
  ...children: Child[]
): ElementDescriptor {
  let resolved = (props ?? {}) as Props;
  if (children.length) {
    resolved = mergeProps(resolved, {
      children: children.length === 1 ? children[0] : children,
    });
  }
  return { [element]: true, type, props: resolved } as MarkedElement;
}
export const h = createElement;

/** Preserve getters and late spread values; JSX object spread would snapshot them. */
export function mergeProps(...sources: (Props | (() => Props | null | undefined))[]): Props {
  const read = (source: (typeof sources)[number]): Props =>
    (typeof source === "function" ? source() : source) ?? {};
  return new Proxy(
    {},
    {
      get(_target, key) {
        for (let i = sources.length - 1; i >= 0; i--) {
          const source = read(sources[i]);
          if (Object.prototype.hasOwnProperty.call(source, key)) return Reflect.get(source, key);
        }
      },
      has(_target, key) {
        return sources.some((source) => Object.prototype.hasOwnProperty.call(read(source), key));
      },
      ownKeys() {
        return [...new Set(sources.flatMap((source) => Reflect.ownKeys(read(source))))];
      },
      getOwnPropertyDescriptor(_target, key) {
        if (sources.some((source) => Object.prototype.hasOwnProperty.call(read(source), key))) {
          return { enumerable: true, configurable: true };
        }
      },
    },
  );
}

// A removable parent link matters for long-lived lists: removed rows must not
// remain captured by their parent's cleanup list until the entire root dies.
export function lifetime(parent?: Owner): Owner {
  let disposed = false;
  const cleanups = new Set<Cleanup>();
  let unlink: Cleanup | undefined;
  const result: Owner = {
    get disposed() {
      return disposed;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unlink?.();
      const callbacks = [...cleanups].reverse();
      cleanups.clear();
      const errors: unknown[] = [];
      for (const cleanup of callbacks) {
        try {
          cleanup();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length) throw new AggregateError(errors, "[ui] Cleanup failed");
    },
    [Symbol.dispose]() {
      result.dispose();
    },
    onCleanup(cleanup) {
      if (disposed) {
        cleanup();
        return () => {};
      }
      cleanups.add(cleanup);
      return () => {
        cleanups.delete(cleanup);
      };
    },
  };
  if (parent) ownerParents.set(result, parent);
  unlink = parent?.onCleanup(() => result.dispose());
  return result;
}

function ownedBy(owner: Owner, ancestor: Owner): boolean {
  for (let current: Owner | undefined = owner; current; current = ownerParents.get(current)) {
    if (current === ancestor) return true;
  }
  return false;
}

function context(): UIContext {
  if (!activeContext) throw new Error("[ui] This API must run inside a mounted component");
  return activeContext;
}

export function runIn<T>(ctx: UIContext, callback: () => T): T {
  const previous = activeContext;
  activeContext = ctx;
  try {
    return scoped(ctx.scope, () => withOwner(ctx.owner, () => withSidScope(ctx.path, callback)));
  } finally {
    activeContext = previous;
  }
}

export function childContext(parent: UIContext, stableSegment?: string): UIContext {
  return {
    ...parent,
    owner: lifetime(parent.owner),
    path: `${parent.path}.${stableSegment ?? parent.nextChild++}`,
    nextChild: 0,
    nextId: 0,
    setup: undefined,
  };
}

export function createRootContext(
  options: RenderOptions & { server?: boolean; document?: Document; namespace?: string } = {},
): UIContext {
  return {
    scope:
      unwrapMicroScope(options.scope ?? (options.server ? null : getCurrentScope())) ??
      createScope(),
    owner: lifetime(),
    document: options.document,
    namespace: options.namespace ?? htmlNamespace,
    values: new Map(),
    root: {
      depth: 0,
      mounts: [],
      errors: [],
      pendingModels: new Set(),
      server: options.server ?? false,
    },
    path: `ui:${encodeURIComponent(options.identifierPrefix ?? "root")}`,
    nextChild: 0,
    nextId: 0,
  };
}

function disposeReplaced(ctx: UIContext | undefined): void {
  if (!ctx) return;
  try {
    ctx.owner.dispose();
  } catch (error) {
    // A committed replacement still receives its mount hooks if teardown fails.
    ctx.root.errors.push(error);
  }
}

function flushMounts(root: RootState): void {
  if (root.depth) return;
  root.depth++;
  const errors = root.errors.splice(0);
  try {
    while (root.mounts.length) {
      const pending = root.mounts.splice(0);
      // Adopt every foreign SSR host before native mounted handlers can mutate
      // the shared scope or replace the just-hydrated children.
      pending.sort((a, b) => Number(b.hydrateForeign) - Number(a.hydrateForeign));
      for (const { context: ctx, callback, unregister } of pending) {
        unregister();
        if (ctx.owner.disposed) continue;
        try {
          const cleanup = runIn(ctx, callback);
          if (typeof cleanup === "function") ctx.owner.onCleanup(() => runIn(ctx, cleanup));
        } catch (error) {
          try {
            ctx.owner.dispose();
          } catch {
            /* preserve the mount error */
          }
          errors.push(error);
        }
      }
    }
  } finally {
    root.depth--;
  }
  errors.push(...root.errors.splice(0));
  settleRetained(root, errors.length === 0);
  if (errors.length === 1) throw errors[0];
  if (errors.length) throw new AggregateError(errors, "[ui] Mount callbacks failed");
}

/** Finalize model instances only after a complete client or server commit. */
export function settleRetained(root: RootState, succeeded: boolean): void {
  for (const record of root.pendingModels) {
    if (succeeded) record.committed = true;
    else if (record.model.alive) record.model.dispose();
  }
  root.pendingModels.clear();
}

function mountWork<T>(ctx: UIContext, callback: () => T): T {
  ctx.root.depth++;
  let succeeded = false;
  try {
    const value = runIn(ctx, callback);
    succeeded = true;
    return value;
  } finally {
    ctx.root.depth--;
    if (succeeded) flushMounts(ctx.root);
  }
}

function bind<T>(ctx: UIContext, read: () => T, patch: (value: T) => void): void {
  let initializing = true;
  let failed = false;
  let failure: unknown;
  const modelSubscriptions = new Map<ModelFieldReadSource, Cleanup>();
  ctx.owner.onCleanup(() => {
    for (const unsubscribe of modelSubscriptions.values()) unsubscribe();
    modelSubscriptions.clear();
  });
  let subscription: ReturnType<typeof reaction> | undefined;
  subscription = runIn(ctx, () =>
    reaction({
      scope: ctx.scope,
      run() {
        if (ctx.owner.disposed) return;
        try {
          // Keep the reaction's micro-scope while reading, then leave it before
          // mounting descendants so their setup reads do not subscribe this region.
          const previous = activeContext;
          activeContext = ctx;
          let value: T;
          const readModels = new Set<ModelFieldReadSource>();
          try {
            value = collectModelFieldReads((source) => readModels.add(source), read);
          } finally {
            activeContext = previous;
          }
          for (const [source, unsubscribe] of modelSubscriptions) {
            if (readModels.has(source)) continue;
            unsubscribe();
            modelSubscriptions.delete(source);
          }
          for (const source of readModels) {
            if (modelSubscriptions.has(source)) continue;
            modelSubscriptions.set(
              source,
              source.subscribe(() => {
                if (ctx.owner.disposed || !subscription) return;
                void run({ unit: subscription.node, scope: ctx.scope }).catch(() => {});
              }),
            );
          }
          mountWork(ctx, () => patch(value));
        } catch (error) {
          // Core reports detached reaction errors. Initial DOM mount is synchronous
          // and must instead fail render() so it can roll back the entire subtree.
          if (!initializing) throw error;
          failed = true;
          failure = error;
        }
      },
    }),
  );
  initializing = false;
  if (failed) {
    subscription.stop();
    throw failure;
  }
}

export interface RenderOptions {
  scope?: Scope;
  /** Use the same unique prefix for each server/client root pair. */
  identifierPrefix?: string;
}

/** A foreign renderer owns everything inside its native host element. */
export interface ForeignRoot<Value> {
  update(value: Value): void;
  dispose(): void;
}

/** Internal bridge contract; the foreign renderer owns the host's entire contents. */
export interface ForeignProps<Value> {
  readonly kind?: string;
  readonly as?: string;
  readonly node: Value;
  /** Supplied by server entrypoints, never by the browser adapter. */
  readonly serverRender?: (node: Value, scope: Scope) => string | Promise<string>;
  /** Reject synchronous SSR before starting an asynchronous renderer. */
  readonly asyncServerRender?: boolean;
  readonly mount: (
    host: Element,
    node: Value,
    scope: Scope,
    options: { hydrate: boolean; hydrationScope?: Scope },
  ) => ForeignRoot<Value>;
}

/** Create an opaque host without making the foreign node a native UI child. */
export function foreignTree<Value>(props: ForeignProps<Value>): ElementDescriptor {
  return createElement(foreign, props);
}

const invalidForeignHosts = new Set([
  "html",
  "head",
  "body",
  "template",
  "noscript",
  "iframe",
  "noembed",
  "noframes",
  "plaintext",
  "xmp",
  "listing",
  "svg",
  "math",
  "select",
  "option",
  "optgroup",
]);

/** Host tags must parse as ordinary non-void HTML elements on both sides. */
export function foreignHostTag(value: unknown, namespace: string): string {
  const tag = value ?? "div";
  if (
    namespace !== htmlNamespace ||
    typeof tag !== "string" ||
    !/^[a-z][a-z0-9-]*$/.test(tag) ||
    invalidForeignHosts.has(tag) ||
    voidElements.has(tag) ||
    rawTextElements.has(tag)
  ) {
    throw new Error("[ui] Foreign tree requires a non-void HTML host tag");
  }
  return tag;
}

/** Mount an independently disposable root. Existing container children are preserved. */
export function render(
  factory: () => Child,
  container: Parent,
  options: RenderOptions = {},
): Cleanup {
  return mountRoot(factory, container, options, false);
}

/** Attach bindings to renderToString output without replacing its DOM nodes. */
export function hydrate(
  factory: () => Child,
  container: Parent,
  options: RenderOptions = {},
): Cleanup {
  return mountRoot(factory, container, options, true);
}

function mountRoot(
  factory: () => Child,
  container: Parent,
  options: RenderOptions,
  hydrating: boolean,
): Cleanup {
  const document = container.ownerDocument;
  if (!document) throw new Error("[ui] render requires a DOM container");
  const ctx = createRootContext({
    ...options,
    document,
    namespace:
      container.nodeType === 1
        ? ((container as Element).namespaceURI ?? htmlNamespace)
        : htmlNamespace,
  });
  if (hydrating) {
    ctx.root.hydration = { active: true, failed: false, cursors: new Map() };
    ctx.root.depth++;
  }
  try {
    mountWork(ctx, () => mount(factory(), container, null, ctx));
    if (hydrating) {
      assertHydrated(container, null, ctx);
      ctx.root.hydration!.active = false;
      ctx.root.depth--;
      flushMounts(ctx.root);
      ctx.root.hydration!.cursors.clear();
    }
  } catch (error) {
    if (ctx.root.hydration?.active) ctx.root.hydration.failed = true;
    try {
      ctx.owner.dispose();
    } catch {
      /* preserve the original mount failure */
    }
    ctx.root.mounts.length = 0;
    ctx.root.errors.length = 0;
    throw error;
  }
  return () => {
    try {
      runIn(ctx, () => ctx.owner.dispose());
    } finally {
      ctx.root.mounts.length = 0;
      ctx.root.errors.length = 0;
    }
  };
}

export function useScope(): Scope {
  return context().scope;
}
/** Stable across SSR/hydration for an identical tree and identifierPrefix. */
export function useId(): string {
  const ctx = context();
  return `${ctx.path}-id${ctx.nextId++}`;
}
/** Run when this client component's owner is disposed. */
export function onUnmount(cleanup: Cleanup): void {
  const ctx = context();
  if (ctx.root.server) return;
  if (ctx.setup) {
    ctx.setup.unmounts.push(cleanup);
    return;
  }
  ctx.owner.onCleanup(() => runIn(ctx, cleanup));
}
export function onMount(callback: () => void | Cleanup): void {
  const ctx = context();
  if (ctx.root.server) return;
  if (ctx.setup) {
    ctx.setup.mounts.push(callback);
    return;
  }
  queueMount(ctx, callback);
}

function queueMount(ctx: UIContext, callback: () => void | Cleanup, hydrateForeign = false): void {
  const task: MountTask = { context: ctx, callback, unregister: () => {}, hydrateForeign };
  ctx.root.mounts.push(task);
  task.unregister = ctx.owner.onCleanup(() => {
    const index = ctx.root.mounts.indexOf(task);
    if (index >= 0) ctx.root.mounts.splice(index, 1);
  });
}

/** Resolve a function component to its per-id staticModel instance and reusable setup output. */
export function componentView(type: Component<any>, props: Props, ctx: UIContext): Child {
  const metadata = componentMetadataOf(type);
  const supplied = props.id;
  const id =
    supplied === undefined || supplied === null ? (metadata.id?.(props) ?? ctx.path) : supplied;
  if (typeof id !== "string" || !id.length) {
    throw new TypeError("[ui] Component id must be a non-empty string");
  }

  const models = collection(metadata.model, ctx.scope);
  const model = (models.get(id) ?? models.add({ id })) as ComponentModel;
  const instanceScope = modelInstanceBindingOf(model)?.scope;
  if (!instanceScope) throw new Error("[ui] Component model has no instance scope");
  let record = componentRecords.get(model);
  const previousMount = record?.mounted;
  if (previousMount && !previousMount.disposed) {
    if (
      !metadata.keep ||
      !ctx.replacing ||
      ctx.replacing.disposed ||
      !ownedBy(previousMount, ctx.replacing)
    ) {
      throw new Error(
        `[ui] Component ${type.name || "<anonymous>"} with id "${id}" is already mounted`,
      );
    }
  }

  if (!record) {
    const setupOwner = lifetime();
    record = {
      model,
      setupOwner,
      mounts: [],
      unmounts: [],
      declarations: [],
      lifecycle: {
        mounted: bindEventToScope(metadata.lifecycle.mounted, instanceScope),
        unmounted: bindEventToScope(metadata.lifecycle.unmounted, instanceScope),
      },
      instanceScope,
      committed: false,
      props,
      values: ctx.values,
    };
    const current = record;
    componentRecords.set(model, current);
    if (metadata.keep) ctx.root.pendingModels.add(current);
    // Core scope snapshots must remain readable after server rendering. On the
    // client, a final component disposal removes only stores declared by this
    // setup, allowing the same compiled SID to be declared on a later mount.
    setupOwner.onCleanup(() => {
      if (!ctx.root.server) {
        for (const declaration of current.declarations) {
          releaseStoreDeclaration(ctx.scope, declaration);
        }
      }
    });
    model.onCleanup(() => {
      current.disposing = true;
      try {
        current.mounted?.dispose();
      } finally {
        current.setupOwner.dispose();
        componentRecords.delete(model);
        ctx.root.pendingModels.delete(current);
      }
    });
    const propsProxy = new Proxy({} as Props, {
      get: (_target, key) => Reflect.get(current.props, key),
      has: (_target, key) => Reflect.has(current.props, key),
      ownKeys: () => Reflect.ownKeys(current.props),
      getOwnPropertyDescriptor: (_target, key) => {
        const descriptor = Reflect.getOwnPropertyDescriptor(current.props, key);
        return descriptor ? { ...descriptor, configurable: true } : undefined;
      },
    });
    const setupContext: UIContext = { ...ctx, owner: setupOwner, setup: current };
    try {
      current.view = runIn(setupContext, () =>
        withStoreDeclarationTracker(
          (declaration) => current.declarations.push(declaration),
          () => metadata.view(propsProxy, current.lifecycle),
        ),
      );
    } catch (error) {
      const failures: unknown[] = [error];
      for (const callback of current.unmounts) {
        try {
          runIn(ctx, callback);
        } catch (cleanupError) {
          failures.push(cleanupError);
        }
      }
      try {
        setupOwner.dispose();
      } catch (cleanupError) {
        failures.push(cleanupError);
      }
      try {
        model.dispose();
      } catch (cleanupError) {
        failures.push(cleanupError);
      }
      if (failures.length > 1) {
        throw new AggregateError(failures, "[ui] Component setup and cleanup failed");
      }
      throw error;
    }
  }

  const previousProps = record.props;
  const previousValues = record.values;
  record.props = props;
  record.values = ctx.values;
  record.mounted = ctx.owner;
  const current = record;
  // This callback is registered first, so DOM teardown and onUnmount callbacks
  // run before a non-kept model's final cleanup.
  ctx.owner.onCleanup(() => {
    if (current.mounted !== ctx.owner) return;
    if (!current.disposing && previousMount && !previousMount.disposed) {
      current.mounted = previousMount;
      current.props = previousProps;
      current.values = previousValues;
      return;
    }
    current.mounted = undefined;
    if (
      (!metadata.keep || (!current.committed && !ctx.root.serverSucceeded)) &&
      model.alive &&
      !current.disposing
    ) {
      current.disposing = true;
      try {
        current.setupOwner.dispose();
      } finally {
        model.dispose();
      }
    }
  });
  for (const callback of current.unmounts) {
    ctx.owner.onCleanup(() => {
      const latestProps = current.props;
      const latestValues = current.values;
      current.props = props;
      current.values = ctx.values;
      try {
        runIn(ctx, callback);
      } finally {
        current.props = latestProps;
        current.values = latestValues;
      }
    });
  }
  for (const callback of current.mounts) queueMount(ctx, callback);
  if (!ctx.root.server) {
    const payload: ComponentLifecycleEvent<Props> = { id, model, props, scope: ctx.scope };
    let didMount = false;
    ctx.owner.onCleanup(() => {
      if (didMount)
        runDetached({
          unit: metadata.lifecycle.unmounted.node,
          payload,
          scope: current.instanceScope,
        });
    });
    queueMount(ctx, () => {
      didMount = true;
      runDetached({ unit: metadata.lifecycle.mounted.node, payload, scope: current.instanceScope });
    });
  }
  return current.view;
}

/** A component-owned event with one scoped reaction as its handler. */
export function action<Payload = unknown>(run: ReactionRun<Payload>): EventCallable<Payload>;
export function action<Payload = unknown>(
  name: string,
  run: ReactionRun<Payload>,
): EventCallable<Payload>;
export function action<Payload = unknown>(
  nameOrRun: string | ReactionRun<Payload>,
  maybeRun?: ReactionRun<Payload>,
): EventCallable<Payload> {
  const ctx = context();
  const name = typeof nameOrRun === "string" ? nameOrRun : undefined;
  const handler = typeof nameOrRun === "string" ? maybeRun : nameOrRun;
  if (!handler) throw new TypeError("[ui] action requires a reaction handler");
  return runIn(ctx, () => {
    const trigger = event<Payload>(name);
    reaction<Payload>({
      on: trigger,
      scope: ctx.scope,
      name: name ? `${name}.reaction` : undefined,
      run: handler,
    });
    return trigger;
  });
}

function ownNode(node: Node, ctx: UIContext): void {
  ctx.owner.onCleanup(() => {
    if (!ctx.root.hydration?.active && !ctx.root.hydration?.failed)
      node.parentNode?.removeChild(node);
  });
}

function hydrationCursor(parent: Parent, ctx: UIContext): Node | null {
  const cursors = ctx.root.hydration!.cursors;
  if (!cursors.has(parent)) cursors.set(parent, parent.firstChild);
  return cursors.get(parent)!;
}

function hydrationMismatch(expected: string): never {
  throw new Error(
    `[ui] Hydration mismatch: expected ${expected}. Use the same tree, scope snapshot, compiler root and identifierPrefix on server and client.`,
  );
}

function assertHydrated(parent: Parent, end: Node | null, ctx: UIContext): void {
  if (ctx.root.hydration?.active && hydrationCursor(parent, ctx) !== end)
    hydrationMismatch("end of owned content");
}

function insert<T extends Node>(node: T, parent: Parent, before: Node | null, ctx: UIContext): T {
  const hydration = ctx.root.hydration;
  if (hydration?.active) {
    let found = hydrationCursor(parent, ctx);
    if (node.nodeType === 3) {
      if (found?.nodeType !== 8 || (found as Comment).data !== "ui:t")
        hydrationMismatch("text marker");
      ownNode(found, ctx);
      found = found.nextSibling;
      if (node.textContent === "" && found?.nodeType !== 3) {
        parent.insertBefore(node, found);
        found = node;
      }
      if (found?.nodeType !== 3 || found.textContent !== node.textContent)
        hydrationMismatch("matching text");
    } else if (node.nodeType === 1) {
      const expected = node as unknown as Element;
      if (
        found?.nodeType !== 1 ||
        (found as Element).localName !== expected.localName ||
        (found as Element).namespaceURI !== expected.namespaceURI
      )
        hydrationMismatch(`<${expected.localName}>`);
    } else hydrationMismatch("an element or text node");
    hydration.cursors.set(parent, found!.nextSibling);
    node = found as T;
  } else parent.insertBefore(node, before);
  ownNode(node, ctx);
  return node;
}

export function isElement(value: unknown): value is MarkedElement {
  return typeof value === "object" && value !== null && (value as MarkedElement)[element] === true;
}

function mount(value: Child, parent: Parent, before: Node | null, ctx: UIContext): void {
  if (value == null || typeof value === "boolean") return;
  if (typeof value === "function") {
    mountDynamic(value, parent, before, ctx);
    return;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") {
    insert(ctx.document!.createTextNode(String(value)), parent, before, ctx);
    return;
  }
  if (Array.isArray(value)) {
    for (const child of value) mount(child, parent, before, ctx);
    return;
  }
  if (isElement(value)) {
    const { type, props } = value;
    if (type === Fragment) {
      mount(() => props.children as Child, parent, before, ctx);
      return;
    }
    if (type === list) {
      mountList(props as unknown as ForProps<unknown>, parent, before, ctx);
      return;
    }
    if (type === show) {
      mountShow(props as unknown as ShowProps, parent, before, ctx);
      return;
    }
    if (type === provider) {
      const child = childContext(ctx);
      const values = new Map(ctx.values);
      values.set(props.id as symbol, () => props.value);
      child.values = values;
      runIn(child, () => mount(() => props.children as Child, parent, before, child));
      return;
    }
    if (type === portal) {
      const target = props.mount as Parent;
      if (!target || typeof target.insertBefore !== "function")
        throw new Error("[ui] Portal requires a DOM mount target");
      const child = childContext(ctx);
      child.document = target.ownerDocument;
      child.namespace =
        target.nodeType === 1 ? ((target as Element).namespaceURI ?? htmlNamespace) : htmlNamespace;
      runIn(child, () => mount(() => props.children as Child, target, null, child));
      return;
    }
    if (type === foreign) {
      mountForeign(props as unknown as ForeignProps<unknown>, parent, before, ctx);
      return;
    }
    if (typeof type === "function") {
      const child = childContext(ctx);
      try {
        runIn(child, () => mount(componentView(type, props, child), parent, before, child));
      } catch (error) {
        try {
          child.owner.dispose();
        } catch {}
        throw error;
      }
      return;
    }
    if (typeof type === "string") {
      mountElement(type, props, parent, before, ctx);
      return;
    }
  }
  // ownerDocument.defaultView is absent for some detached documents; structural
  // node detection also accepts nodes from another window.
  if (typeof value === "object" && "nodeType" in value && "cloneNode" in value) {
    insert(value as Node, parent, before, ctx);
    return;
  }
  throw new TypeError("[ui] Unsupported child; render a primitive, JSX element or accessor");
}

function mountForeign(
  props: ForeignProps<unknown>,
  parent: Parent,
  before: Node | null,
  ctx: UIContext,
): void {
  const tag = foreignHostTag(props.as, ctx.namespace);
  const child = childContext(ctx);
  const host = insert(ctx.document!.createElement(tag), parent, before, child);
  const serverKind = ctx.root.hydration?.active ? host.getAttribute("data-ui-ssr") : null;
  const hydrateForeign = serverKind !== null;
  if (hydrateForeign && serverKind !== (props.kind ?? "foreign")) {
    hydrationMismatch(`a ${props.kind ?? "foreign"} SSR host`);
  }
  // Foreign HTML is opaque to native hydration. Client-only hosts must still be
  // empty; the bridge starts only after the entire native tree has been claimed.
  if (!hydrateForeign) assertHydrated(host, null, child);

  let value: unknown;
  let initialValue: unknown;
  let initialized = false;
  let root: ForeignRoot<unknown> | undefined;
  bind(
    child,
    () => props.node,
    (next) => {
      if (!initialized) {
        initialized = true;
        initialValue = next;
      }
      value = next;
      root?.update(next);
    },
  );
  const hydrationScope = hydrateForeign ? captureScopeSnapshot(child.scope) : undefined;
  queueMount(
    child,
    () => {
      root = props.mount(host, hydrateForeign ? initialValue : value, child.scope, {
        hydrate: hydrateForeign,
        hydrationScope,
      });
      try {
        if (hydrateForeign && !Object.is(value, initialValue)) root.update(value);
      } catch (error) {
        const mounted = root;
        root = undefined;
        try {
          mounted.dispose();
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], "[ui] Foreign hydration update failed");
        }
        throw error;
      }
      return () => {
        const mounted = root;
        root = undefined;
        mounted?.dispose();
      };
    },
    hydrateForeign,
  );
}

interface Region {
  start: Comment;
  end: Comment;
  context: UIContext;
  hydrating?: boolean;
}
function region(
  parent: Parent,
  before: Node | null,
  ctx: UIContext,
  stableSegment?: string,
): Region {
  const child = childContext(ctx, stableSegment);
  if (ctx.root.hydration?.active) {
    const start = hydrationCursor(parent, ctx);
    if (start?.nodeType !== 8 || (start as Comment).data !== "ui")
      hydrationMismatch("region start marker");
    let depth = 1;
    let end = start.nextSibling;
    while (end) {
      if (end.nodeType === 8) {
        if ((end as Comment).data === "ui") depth++;
        if ((end as Comment).data === "/ui" && --depth === 0) break;
      }
      end = end.nextSibling;
    }
    if (!end) hydrationMismatch("region end marker");
    ownNode(start, child);
    ownNode(end, child);
    ctx.root.hydration.cursors.set(parent, start.nextSibling);
    return { start: start as Comment, end: end as Comment, context: child, hydrating: true };
  }
  const start = ctx.document!.createComment("ui");
  const end = ctx.document!.createComment("/ui");
  insert(start, parent, before, child);
  insert(end, parent, before, child);
  return { start, end, context: child };
}

function finishRegion(target: Region, parent: Parent): void {
  if (!target.hydrating) return;
  assertHydrated(parent, target.end, target.context);
  target.context.root.hydration!.cursors.set(parent, target.end.nextSibling);
  target.hydrating = false;
}

function mountDynamic(
  read: () => Child,
  parent: Parent,
  before: Node | null,
  ctx: UIContext,
): void {
  const target = region(parent, before, ctx);
  let content: UIContext | undefined;
  let previous: Child;
  let text: Text | undefined;
  bind(target.context, read, (next) => {
    if (Object.is(next, previous)) return;
    const primitive =
      typeof next === "string" || typeof next === "number" || typeof next === "bigint";
    if (primitive && text) {
      const data = String(next);
      if (text.data !== data) text.data = data;
    } else {
      const candidate = childContext(target.context);
      candidate.replacing = content?.owner ?? target.context.replacing;
      let nextText: Text | undefined;
      if (primitive) {
        nextText = insert(
          ctx.document!.createTextNode(String(next)),
          parent,
          target.end,
          candidate,
        );
      } else {
        try {
          runIn(candidate, () => mount(next, parent, target.end, candidate));
        } catch (error) {
          try {
            candidate.owner.dispose();
          } catch {}
          throw error;
        }
      }
      const old = content;
      content = candidate;
      text = nextText;
      previous = next;
      disposeReplaced(old);
    }
    previous = next;
  });
  finishRegion(target, parent);
}

function normalizedStyle(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value));
}

function mountElement(
  tag: string,
  props: Props,
  parent: Parent,
  before: Node | null,
  ctx: UIContext,
): void {
  const namespace = tag === "svg" ? svgNamespace : tag === "math" ? mathNamespace : ctx.namespace;
  let dom =
    namespace === htmlNamespace
      ? ctx.document!.createElement(tag)
      : ctx.document!.createElementNS(namespace, tag);
  const child = childContext(ctx);
  child.namespace = tag === "foreignObject" ? htmlNamespace : namespace;
  dom = insert(dom, parent, before, child);
  let previous = new Map<string, unknown>();
  const listeners = new Map<string, Cleanup>();
  let refCleanup: Cleanup | undefined;
  child.owner.onCleanup(() => {
    for (const remove of listeners.values()) remove();
    listeners.clear();
    refCleanup?.();
  });
  bind(
    child,
    () => {
      const values = new Map<string, unknown>();
      for (const key of Object.keys(props)) {
        if (key === "children" || key === "key") continue;
        const value = props[key];
        values.set(key, key === "style" || key === "classList" ? normalizedStyle(value) : value);
      }
      return values;
    },
    (next) => {
      for (const key of previous.keys()) {
        if (!next.has(key)) next.set(key, undefined);
      }
      for (const [key, value] of next) {
        if (Object.is(previous.get(key), value)) continue;
        if (key === "ref") {
          refCleanup?.();
          refCleanup = undefined;
          if (typeof value === "function") {
            const cleanup = runIn(child, () => value(dom));
            if (typeof cleanup === "function") refCleanup = cleanup;
          } else if (value && typeof value === "object") {
            (value as { current: Element | null }).current = dom;
            refCleanup = () => {
              (value as { current: Element | null }).current = null;
            };
          }
        } else if (key === "classList") {
          // Apply after class/className regardless of JSX attribute order.
        } else if (key === "style") {
          patchStyle(dom, value, previous.get(key));
        } else if (key.startsWith("on")) {
          listeners.get(key)?.();
          listeners.delete(key);
          if (typeof value === "function") {
            const capture = key.endsWith("Capture") && !key.startsWith("on:");
            let name = key.startsWith("on:")
              ? key.slice(3)
              : key.slice(2, capture ? -7 : undefined).toLowerCase();
            if (name === "doubleclick") name = "dblclick";
            const handler = (event: Event) => {
              if (!child.owner.disposed) runIn(child, () => value(event));
            };
            dom.addEventListener(name, handler, capture);
            listeners.set(key, () => dom.removeEventListener(name, handler, capture));
          }
        } else patchProperty(dom, key, value);
      }
      if (next.has("classList") || previous.has("classList")) {
        const prev = (previous.get("classList") ?? {}) as Record<string, unknown>;
        const current = (next.get("classList") ?? {}) as Record<string, unknown>;
        for (const name of new Set([...Object.keys(prev), ...Object.keys(current)])) {
          dom.classList.toggle(name, Boolean(current[name]));
        }
      }
      previous = next;
    },
  );
  if (namespace === htmlNamespace && voidElements.has(tag)) {
    if (props.children != null && typeof props.children !== "boolean")
      throw new Error(`[ui] Void element <${tag}> cannot have children`);
  } else if (namespace === htmlNamespace && rawTextElements.has(tag)) {
    bind(
      child,
      () =>
        rawText(
          tag === "textarea"
            ? "value" in props
              ? props.value
              : "defaultValue" in props
                ? props.defaultValue
                : props.children
            : props.children,
        ),
      (value) => {
        if (ctx.root.hydration?.active && dom.textContent !== value)
          hydrationMismatch(`matching <${tag}> text`);
        if (tag === "textarea") {
          if (
            (!ctx.root.hydration?.active || "value" in props) &&
            (dom as HTMLTextAreaElement).value !== value
          )
            (dom as HTMLTextAreaElement).value = value;
        } else if (dom.textContent !== value) dom.textContent = value;
      },
    );
  } else {
    runIn(child, () => mount(() => props.children as Child, dom, null, child));
    assertHydrated(dom, null, child);
  }
  // Options must exist before the initial live selection is applied.
  if (tag === "select" && "value" in props) patchProperty(dom, "value", props.value);
}

export const voidElements = new Set(
  "area base br col embed hr img input link meta param source track wbr".split(" "),
);
export const rawTextElements = new Set(["textarea", "title", "script", "style"]);
export function rawText(value: unknown): string {
  if (typeof value === "function") return rawText(value());
  if (value == null || typeof value === "boolean") return "";
  if (Array.isArray(value)) return value.map(rawText).join("");
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint")
    return String(value);
  throw new Error("[ui] Raw-text elements accept only primitive text children");
}

export const booleanAttributes = new Set(
  "allowfullscreen async autofocus autoplay checked controls default defer disabled formnovalidate hidden inert ismap itemscope loop multiple muted nomodule novalidate open playsinline readonly required reversed selected".split(
    " ",
  ),
);
export const svgDashedAttributes = new Set(
  "accentHeight alignmentBaseline arabicForm baselineShift capHeight clipPath clipRule colorInterpolation colorInterpolationFilters colorProfile colorRendering dominantBaseline enableBackground fillOpacity fillRule floodColor floodOpacity fontFamily fontSize fontSizeAdjust fontStretch fontStyle fontVariant fontWeight glyphName glyphOrientationHorizontal glyphOrientationVertical horizAdvX horizOriginX imageRendering letterSpacing lightingColor markerEnd markerMid markerStart overlinePosition overlineThickness paintOrder panose1 pointerEvents renderingIntent shapeRendering stopColor stopOpacity strikethroughPosition strikethroughThickness strokeDasharray strokeDashoffset strokeLinecap strokeLinejoin strokeMiterlimit strokeOpacity strokeWidth textAnchor textDecoration textRendering transformOrigin underlinePosition underlineThickness unicodeBidi unicodeRange unitsPerEm vectorEffect vertAdvY vertOriginX vertOriginY wordSpacing writingMode xHeight".split(
    " ",
  ),
);
function patchProperty(dom: Element, key: string, value: unknown): void {
  if (key === "dangerouslySetInnerHTML" || key === "innerHTML" || key === "textContent") {
    throw new Error(`[ui] ${key} cannot be mixed with owned DOM children`);
  }
  let name = key === "className" ? "class" : key === "htmlFor" ? "for" : key;
  const html = dom.namespaceURI === htmlNamespace;
  if (html && dom.localName === "select" && key === "value" && Array.isArray(value)) {
    const selected = new Set(value.map(String));
    for (const option of (dom as HTMLSelectElement).options)
      option.selected = selected.has(option.value);
    return;
  }
  if (!html && svgDashedAttributes.has(name))
    name = name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
  // Property writes preserve browser semantics of live controls. Avoid redundant
  // value assignments, which can otherwise move the input selection.
  if (
    html &&
    (key === "value" ||
      key === "defaultValue" ||
      key === "checked" ||
      key === "defaultChecked" ||
      key === "selected" ||
      key === "indeterminate")
  ) {
    const properties = dom as unknown as Record<string, unknown>;
    const next =
      key === "value" || key === "defaultValue"
        ? value == null
          ? ""
          : String(value)
        : Boolean(value);
    if (!Object.is(properties[key], next)) properties[key] = next;
    return;
  }
  if (value == null || (booleanAttributes.has(name.toLowerCase()) && !value))
    dom.removeAttribute(name);
  else if (booleanAttributes.has(name.toLowerCase())) dom.setAttribute(name, "");
  else if (name === "xlink:href")
    dom.setAttributeNS("http://www.w3.org/1999/xlink", name, String(value));
  else dom.setAttribute(name, String(value));
}

function patchStyle(dom: Element, value: unknown, previous: unknown): void {
  const style = (dom as HTMLElement | SVGElement).style;
  if (value == null || typeof value === "string") {
    style.cssText = value ?? "";
    return;
  }
  if (typeof previous === "string") style.cssText = "";
  const next = value as Record<string, unknown>;
  const prev =
    previous && typeof previous === "object" ? (previous as Record<string, unknown>) : {};
  for (const key of new Set([...Object.keys(prev), ...Object.keys(next)])) {
    const name = key.startsWith("--")
      ? key
      : key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
    const item = next[key];
    if (item == null) style.removeProperty(name);
    else if (!Object.is(prev[key], item)) style.setProperty(name, String(item));
  }
}

export interface ShowProps {
  when: unknown | (() => unknown);
  children?: Child;
  fallback?: Child;
}
export function Show(props: ShowProps): ElementDescriptor {
  return createElement(show, props);
}
export function readSource<T>(value: T | (() => T)): T {
  return typeof value === "function" ? (value as () => T)() : value;
}
function mountShow(props: ShowProps, parent: Parent, before: Node | null, ctx: UIContext): void {
  const target = region(parent, before, ctx);
  let previous: boolean | undefined;
  let content: UIContext | undefined;
  bind(
    target.context,
    () => Boolean(readSource(props.when)),
    (visible) => {
      if (visible === previous) return;
      const candidate = childContext(target.context, visible ? "shown" : "fallback");
      candidate.replacing = content?.owner ?? target.context.replacing;
      try {
        runIn(candidate, () =>
          mount(() => (visible ? props.children : props.fallback), parent, target.end, candidate),
        );
      } catch (error) {
        try {
          candidate.owner.dispose();
        } catch {}
        throw error;
      }
      const old = content;
      content = candidate;
      previous = visible;
      disposeReplaced(old);
    },
  );
  finishRegion(target, parent);
}

export interface ForProps<T> {
  each: Iterable<T> | (() => Iterable<T>);
  by?: (item: T) => unknown;
  children: (item: () => T, index: () => number) => Child;
  fallback?: Child;
}

export interface ModelForProps<M extends AnyModel> extends Omit<ForProps<InstanceOf<M>>, "each"> {
  each: M;
}

/** A model definition reads its collection from the current render scope. */
export function forItems<T>(source: ForProps<T>["each"] | ModelDefinition, scope: Scope): T[] {
  const value = readSource(source);
  const iterable = isModelDefinition(value) ? collection(value, scope) : value;
  return Array.from(iterable as Iterable<T>);
}

/** Model IDs are the row identity; plain values retain the existing identity semantics. */
export function forKey<T>(item: T, by?: (item: T) => unknown): unknown {
  return by ? by(item) : isModelInstance(item) ? (item as { id: string }).id : item;
}

/** Stable row paths for primitive keys, and stable per-list identities for object keys. */
export function listKeyPaths(): (key: unknown) => string {
  const references = new WeakMap<object, number>();
  const symbols = new Map<symbol, number>();
  let next = 0;
  return (key) => {
    if ((typeof key === "object" && key !== null) || typeof key === "function") {
      const reference = key as object;
      let number = references.get(reference);
      if (number === undefined) {
        number = next++;
        references.set(reference, number);
      }
      return `row:ref:${number}`;
    }
    if (typeof key === "symbol") {
      let number = symbols.get(key);
      if (number === undefined) {
        number = next++;
        symbols.set(key, number);
      }
      return `row:symbol:${number}`;
    }
    const raw = `${typeof key}:${String(key)}`;
    return `row:${raw.length}:${encodeURIComponent(raw)}`;
  };
}
export function For<M>(props: M extends AnyModel ? ModelForProps<M> : never): ElementDescriptor;
export function For<T>(props: ForProps<T>): ElementDescriptor;
export function For(props: ForProps<unknown> | ModelForProps<AnyModel>): ElementDescriptor {
  return createElement(list, props);
}
interface Row<T> extends Region {
  item: T;
  index: number;
  changed: ReactiveNode;
}

function mountList<T>(
  props: ForProps<T>,
  parent: Parent,
  before: Node | null,
  ctx: UIContext,
): void {
  const target = region(parent, before, ctx);
  const rowPath = listKeyPaths();
  let rows = new Map<unknown, Row<T>>();
  let fallback: UIContext | undefined;
  bind(
    target.context,
    () => {
      const items = forItems(props.each, target.context.scope);
      const keys = items.map((item) => forKey(item, props.by));
      if (new Set(keys).size !== keys.length) throw new Error("[ui] For requires unique keys");
      return { items, keys };
    },
    ({ items, keys }) => {
      const next = new Map<unknown, Row<T>>();
      const created: Row<T>[] = [];
      let nextFallback = fallback;
      try {
        for (let index = 0; index < items.length; index++) {
          const key = keys[index];
          let row = rows.get(key);
          if (!row) {
            const owned = region(parent, target.end, target.context, rowPath(key));
            // Row bookkeeping is local to its lifetime. Ordinary stores would
            // retain removed row values in a long-lived application Scope.values.
            row = { ...owned, item: items[index], index, changed: node() };
            created.push(row);
            const current = row;
            runIn(row.context, () =>
              mount(
                props.children(
                  () => {
                    trackNode(current.changed);
                    return current.item;
                  },
                  () => {
                    trackNode(current.changed);
                    return current.index;
                  },
                ),
                parent,
                current.end,
                current.context,
              ),
            );
            finishRegion(row, parent);
          }
          next.set(key, row);
        }
        if (!items.length && !nextFallback) {
          nextFallback = childContext(target.context);
          runIn(nextFallback, () => mount(() => props.fallback, parent, target.end, nextFallback!));
        }
      } catch (error) {
        for (const row of created) {
          try {
            row.context.owner.dispose();
          } catch {}
        }
        if (nextFallback !== fallback) {
          try {
            nextFallback?.owner.dispose();
          } catch {}
        }
        throw error;
      }
      const old = rows;
      rows = next;
      const cleanupErrors: unknown[] = [];
      const disposeRemoved = (owner: Owner): void => {
        try {
          owner.dispose();
        } catch (error) {
          cleanupErrors.push(error);
        }
      };
      if (items.length) {
        const oldFallback = fallback;
        fallback = undefined;
        if (oldFallback) disposeRemoved(oldFallback.owner);
      } else fallback = nextFallback;
      for (const [key, row] of old) if (!next.has(key)) disposeRemoved(row.context.owner);
      let cursor: Node = target.end;
      for (const row of [...next.values()].reverse()) {
        if (!ctx.root.hydration?.active)
          moveRange(row.start, row.end, parent, cursor, ctx.document!);
        cursor = row.start;
      }
      const changed: ReactiveNode[] = [];
      items.forEach((item, index) => {
        const row = next.get(keys[index])!;
        if (!Object.is(row.item, item) || row.index !== index) {
          row.item = item;
          row.index = index;
          changed.push(row.changed);
        }
      });
      // All row snapshots are committed before graph propagation. Failures are
      // already reported by the kernel's observer-error channel.
      if (changed.length) void run({ unit: changed, scope: ctx.scope }).catch(() => {});
      // Report after the completed patch's mount callbacks run. A throwing
      // teardown must not leave newly mounted rows without their lifecycle hooks.
      if (cleanupErrors.length) {
        ctx.root.errors.push(new AggregateError(cleanupErrors, "[ui] List cleanup failed"));
      }
    },
  );
  finishRegion(target, parent);
}

function moveRange(start: Node, end: Node, parent: Parent, before: Node, document: Document): void {
  if (end.nextSibling === before) return;
  const focused = document.activeElement as HTMLElement | null;
  let restoresFocus = false;
  let current: Node | null = start;
  while (current) {
    const next: Node | null = current.nextSibling;
    if (focused && (current === focused || current.contains(focused))) restoresFocus = true;
    parent.insertBefore(current, before);
    if (current === end) break;
    current = next;
  }
  if (restoresFocus && focused && document.activeElement !== focused)
    focused.focus({ preventScroll: true });
}

export interface Context<T> {
  readonly id: symbol;
  readonly defaultValue: T;
  readonly Provider: Component<{ value: T; children?: Child }>;
}
export function createContext<T>(defaultValue: T): Context<T> {
  const id = Symbol("virentia.ui.context");
  return {
    id,
    defaultValue,
    Provider: (props) => createElement(provider, mergeProps(props, { id })),
  };
}
/** Accessor keeps a provider's getter reactive without re-running the consumer. */
export function useContext<T>(target: Context<T>): () => T {
  const ctx = context();
  const read = () => (ctx.setup?.values ?? ctx.values).get(target.id);
  return () => {
    const provider = read();
    return provider ? (provider() as T) : target.defaultValue;
  };
}
export function Portal(props: { mount: Parent; children?: Child }): ElementDescriptor {
  return createElement(portal, props);
}
