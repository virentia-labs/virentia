import type { Owner } from "@virentia/core";
import { retainShapes } from "@virentia/core/internal";

type Cleanup = () => void;
type Before = () => void | PromiseLike<unknown>;
export const cleanupResource = Symbol("virentia.ui.cleanup");
interface CleanupResource {
  [cleanupResource](): void;
}
type CleanupEntry = Cleanup | Node | CleanupResource;
type CleanupList = SmallCleanups | CleanupEntry[] | Set<CleanupEntry>;

// A modeled native subtree usually owns 2-6 resources. Array.push grows the
// backing store of [entry] well beyond that; avoid both the growth allocation
// and unused capacity for every small component lifetime.
class SmallCleanups {
  length = 1;
  private first: CleanupEntry | undefined;
  private second: CleanupEntry | undefined;
  private third: CleanupEntry | undefined;
  private fourth: CleanupEntry | undefined;
  private fifth: CleanupEntry | undefined;
  private sixth: CleanupEntry | undefined;
  constructor(entry: CleanupEntry) {
    this.first = entry;
  }
  get(index: number): CleanupEntry {
    switch (index) {
      case 0:
        return this.first!;
      case 1:
        return this.second!;
      case 2:
        return this.third!;
      case 3:
        return this.fourth!;
      case 4:
        return this.fifth!;
      default:
        return this.sixth!;
    }
  }
  set(index: number, entry: CleanupEntry | undefined): void {
    switch (index) {
      case 0:
        this.first = entry;
        break;
      case 1:
        this.second = entry;
        break;
      case 2:
        this.third = entry;
        break;
      case 3:
        this.fourth = entry;
        break;
      case 4:
        this.fifth = entry;
        break;
      default:
        this.sixth = entry;
    }
  }
  indexOf(entry: CleanupEntry): number {
    for (let index = 0; index < this.length; index++) if (this.get(index) === entry) return index;
    return -1;
  }
  remove(entry: CleanupEntry): void {
    const at = this.indexOf(entry);
    if (at === -1) return;
    for (let index = at; index < this.length - 1; index++) this.set(index, this.get(index + 1));
    this.set(--this.length, undefined);
  }
  clear(): void {
    while (this.length) this.set(--this.length, undefined);
  }
}

export interface Lifetime extends Owner {
  /** Closing owners no longer accept DOM updates; refs live until closed. */
  readonly closed: boolean;
  readonly closing: boolean;
  beforeDispose(callback: Before): Cleanup;
  dispose(): Promise<void>;
}

interface State {
  /**
   * Child lifetimes in creation order. A closed child is dropped lazily: it is
   * only counted, and the array is compacted once most entries are closed.
   */
  children?: State[];
  closedChildren: number;
  before?: Set<Before>;
  cleanups?: CleanupList;
  removeNode?: (node: Node) => void;
  readonly owner: Lifetime;
  closing: boolean;
  closed: boolean;
  /** The teardown this lifetime closes in, from the moment it starts closing. */
  teardown?: Teardown;
  unlink?: Cleanup;
  parent?: State;
  /**
   * Nodes placed into an element of this same lifetime, as [node, parent] pairs.
   * They leave together with that element; only a node moved elsewhere is
   * detached separately.
   */
  inner?: Node[];
  /** Element of `hostOwner` that normally receives this lifetime's top-level nodes. */
  hostParent?: Node;
  hostOwner?: State;
}

function stateOf(owner: Owner): State | undefined {
  return LifetimeOwner.stateOf(owner);
}

/**
 * Lifetimes closing together. Their completion promise exists only once
 * something asks for it: a teardown that finishes synchronously and cleanly,
 * the usual case, never allocates one.
 */
class Teardown {
  completion: Promise<void> | undefined = undefined;
  resolve: (() => void) | undefined = undefined;
  reject: ((error: unknown) => void) | undefined = undefined;
  /** Once finished: the aggregated failure, or `null` after a clean teardown. */
  failure: AggregateError | null | undefined = undefined;
  /** A parent emptied in one operation once the group closed: its nodes skip their own removal. */
  clears: Node | undefined = undefined;
  clear: (() => void) | undefined = undefined;
  constructor(readonly group: State[]) {}

  promise(): Promise<void> {
    if (this.completion) return this.completion;
    if (this.failure === null) return (this.completion = resolved);
    const completion =
      this.failure !== undefined
        ? Promise.reject(this.failure)
        : new Promise<void>((resolve, reject) => {
            this.resolve = resolve;
            this.reject = reject;
          });
    // A root may be detached by a host renderer that cannot await. Retain the
    // rejection for callers, while preventing an unhandled rejection in that case.
    void completion.catch(ignore);
    return (this.completion = completion);
  }

  settle(errors: unknown[] | undefined): void {
    if (errors?.length) {
      const failure = new AggregateError(errors, "[ui] Unmount failed");
      this.failure = failure;
      this.reject?.(failure);
    } else {
      this.failure = null;
      this.resolve?.();
    }
  }
}
const resolved = Promise.resolve();
const ignore = (): void => {};

/** Parent-first lifecycle, awaited as a group, followed by physical teardown. */
function close(state: State): Promise<void> {
  return closeLifetime(state) ?? resolved;
}

/** `close`, but `undefined` when the teardown already finished cleanly. */
function closeLifetime(state: State): Promise<void> | undefined {
  const current = state.teardown;
  if (current) return current.failure === null ? undefined : current.promise();
  // Without a teardown, `state` is not closing yet.
  const group: State[] = [state];
  state.closing = true;
  let pending: Promise<unknown>[] | undefined;
  const children = state.children;
  if (children)
    for (let index = 0; index < children.length; index++)
      pending = collectClosing(children[index], group, pending);
  const teardown = new Teardown(group);
  for (let index = 0; index < group.length; index++) group[index].teardown = teardown;
  let errors: unknown[] | undefined;
  for (let index = 0; index < group.length; index++) {
    const before = group[index].before;
    if (before === undefined) continue;
    for (const callback of before) {
      try {
        const result = callback();
        if (result && typeof result.then === "function")
          (pending ??= []).push(Promise.resolve(result));
      } catch (error) {
        (errors ??= []).push(error);
      }
    }
    before.clear();
  }
  if (pending === undefined) {
    finishTeardown(teardown, errors);
    return teardown.failure === null ? undefined : teardown.promise();
  }
  const completion = teardown.promise();
  void Promise.allSettled(pending).then((results) => {
    for (const result of results)
      if (result.status === "rejected") (errors ??= []).push(result.reason);
    finishTeardown(teardown, errors);
  });
  return completion;
}

/**
 * Mark `current`'s subtree closing, parent first, into `group`. A lifetime
 * already closing elsewhere is waited for instead.
 */
function collectClosing(
  current: State,
  group: State[],
  prior: Promise<unknown>[] | undefined,
): Promise<unknown>[] | undefined {
  if (current.closing) {
    if (!current.closed && current.teardown) (prior ??= []).push(current.teardown.promise());
    return prior;
  }
  current.closing = true;
  group.push(current);
  const children = current.children;
  if (children)
    for (let index = 0; index < children.length; index++)
      prior = collectClosing(children[index], group, prior);
  return prior;
}

/** Physical teardown, children before parents. */
function finishTeardown(teardown: Teardown, errors: unknown[] | undefined): void {
  const group = teardown.group;
  const clears = teardown.clears;
  for (let at = group.length - 1; at >= 0; at--) {
    const current = group[at];
    current.closed = true;
    if (current.parent) releaseChild(current.parent);
    current.parent = undefined;
    current.unlink?.();
    current.unlink = undefined;
    // Nodes placed inside an element of this lifetime leave together with
    // it, unless something moved them elsewhere.
    const inner = current.inner;
    if (inner) {
      current.inner = undefined;
      for (let index = inner.length - 2; index >= 0; index -= 2) {
        const node = inner[index];
        const parentNode = node.parentNode;
        if (parentNode !== inner[index + 1] && (clears === undefined || parentNode !== clears))
          try {
            current.removeNode!(node);
          } catch (error) {
            (errors ??= []).push(error);
          }
      }
    }
    // Closing callbacks may cancel one another, but the teardown snapshot
    // must still run in full. Detach an array instead of copying it for every
    // owner; cancellation then cannot splice the array being traversed.
    const cleanups = current.cleanups;
    current.cleanups = undefined;
    const entries =
      cleanups instanceof SmallCleanups || Array.isArray(cleanups)
        ? cleanups
        : cleanups
          ? [...cleanups]
          : undefined;
    for (let index = (entries?.length ?? 0) - 1; index >= 0; index--) {
      const callback = entries instanceof SmallCleanups ? entries.get(index) : entries![index];
      try {
        if (typeof callback === "function") callback();
        else if (cleanupResource in callback) callback[cleanupResource]();
        // A node still inside its host element leaves together with that
        // element when the host's lifetime closes in this same teardown.
        else if (
          (current.hostOwner?.teardown !== teardown ||
            callback.parentNode !== current.hostParent) &&
          (clears === undefined || callback.parentNode !== clears)
        )
          current.removeNode!(callback);
      } catch (error) {
        (errors ??= []).push(error);
      }
    }
    if (Array.isArray(cleanups)) cleanups.length = 0;
    else cleanups?.clear();
    current.children = undefined;
    current.closedChildren = 0;
  }
  if (teardown.clear)
    try {
      teardown.clear();
    } catch (error) {
      (errors ??= []).push(error);
    }
  teardown.settle(errors);
}

/** Nothing in `state`'s subtree is closing or waits for a before-dispose callback. */
function closesAtOnce(state: State): boolean {
  if (state.closing || (state.before !== undefined && state.before.size > 0)) return false;
  const children = state.children;
  if (children)
    for (let index = 0; index < children.length; index++)
      if (!children[index].closed && !closesAtOnce(children[index])) return false;
  return true;
}

/**
 * @internal Close `owners` as one teardown in which their nodes directly inside
 * `parent` do not leave one by one: `clear` empties `parent` once, after every
 * lifetime closed. Only when the teardown is synchronous, with no before-dispose
 * callback in any of them; otherwise returns `false` and closes nothing.
 */
export function closeLifetimesClearing(
  owners: readonly Owner[],
  parent: Node,
  clear: () => void,
): boolean {
  const group: State[] = [];
  for (let index = 0; index < owners.length; index++) {
    const state = stateOf(owners[index]);
    if (!state || !closesAtOnce(state)) return false;
  }
  for (let index = 0; index < owners.length; index++)
    collectClosing(stateOf(owners[index])!, group, undefined);
  const teardown = new Teardown(group);
  teardown.clears = parent;
  teardown.clear = clear;
  for (let index = 0; index < group.length; index++) group[index].teardown = teardown;
  finishTeardown(teardown, undefined);
  return true;
}

/** A child of `parent` closed: compact the list once most of it is closed. */
function releaseChild(parent: State): void {
  const children = parent.children;
  if (!children || parent.closing) return;
  if (++parent.closedChildren * 2 <= children.length) return;
  let live = 0;
  for (let index = 0; index < children.length; index++) {
    const child = children[index];
    if (!child.closed) children[live++] = child;
  }
  children.length = live;
  parent.closedChildren = 0;
}

export function lifetimeContains(parent: Owner, descendant: Owner): boolean {
  if (parent === descendant) return true;
  const state = stateOf(parent);
  if (!state) return false;
  for (let current = stateOf(descendant)?.parent; current; current = current.parent)
    if (current === state) return true;
  return false;
}

/** @internal Native attachment frames can own resources without a second object. */
export class LifetimeOwner implements Lifetime, State {
  #native = true;
  static stateOf(owner: Owner): State | undefined {
    return #native in owner ? (owner as LifetimeOwner) : undefined;
  }
  // Every slot is declared, so a lifetime keeps one hidden class all its life.
  children: State[] | undefined = undefined;
  closedChildren = 0;
  before: Set<Before> | undefined = undefined;
  cleanups?: CleanupList;
  removeNode?: (node: Node) => void;
  inner?: Node[];
  hostParent: Node | undefined = undefined;
  hostOwner: State | undefined = undefined;
  teardown: Teardown | undefined = undefined;
  unlink: Cleanup | undefined = undefined;
  parent?: State;
  closing = false;
  closed = false;
  readonly owner: Lifetime = this;
  #dispose: Lifetime["dispose"] | undefined = undefined;
  #disposeSync: (() => void) | undefined = undefined;
  #beforeDispose: Lifetime["beforeDispose"] | undefined = undefined;
  #onCleanup: Lifetime["onCleanup"] | undefined = undefined;
  constructor(parent?: Owner) {
    const parentState = parent && stateOf(parent);
    if (parentState) {
      if (parentState.closing) throw new Error("[ui] Cannot mount into a closing lifetime");
      // An exact first slot: `[]` would reserve 17 for the usual one or two children.
      if (parentState.children) parentState.children.push(this);
      else parentState.children = [this];
      this.parent = parentState;
    } else if (parent)
      this.unlink = parent.onCleanup(() => {
        void close(this);
      });
  }
  get disposed(): boolean {
    return this.closed;
  }
  // Bound once and kept in private slots: a lifetime's shape does not change
  // when one is read. Assigning one replaces it with an own property.
  get dispose(): Lifetime["dispose"] {
    return (this.#dispose ??= dispose.bind(this));
  }
  set dispose(method: Lifetime["dispose"]) {
    replaceMethod(this, "dispose", method);
  }
  get [Symbol.dispose](): () => void {
    return (this.#disposeSync ??= disposeSync.bind(this));
  }
  set [Symbol.dispose](method: () => void) {
    replaceMethod(this, Symbol.dispose, method);
  }
  get beforeDispose(): Lifetime["beforeDispose"] {
    return (this.#beforeDispose ??= beforeDispose.bind(this));
  }
  set beforeDispose(method: Lifetime["beforeDispose"]) {
    replaceMethod(this, "beforeDispose", method);
  }
  get onCleanup(): Lifetime["onCleanup"] {
    return (this.#onCleanup ??= onCleanup.bind(this));
  }
  set onCleanup(method: Lifetime["onCleanup"]) {
    replaceMethod(this, "onCleanup", method);
  }
}

function replaceMethod(owner: LifetimeOwner, key: PropertyKey, method: unknown): void {
  Object.defineProperty(owner, key, {
    value: method,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function dispose(this: LifetimeOwner): Promise<void> {
  return close(this);
}
function disposeSync(this: LifetimeOwner): void {
  void close(this);
}
function beforeDispose(this: LifetimeOwner, callback: Before): Cleanup {
  if (this.closing) throw new Error("[ui] Lifetime is closing");
  (this.before ??= new Set()).add(callback);
  return () => {
    this.before?.delete(callback);
  };
}
function onCleanup(this: LifetimeOwner, callback: Cleanup): Cleanup {
  if (this.closed) {
    callback();
    return () => {};
  }
  addCleanup(this, callback);
  return () => removeCleanup(this, callback);
}

// Only entries freshly allocated/claimed by the renderer may skip deduplication.
function addCleanup(state: State, entry: CleanupEntry, unique = false): void {
  const list = state.cleanups;
  if (!list) state.cleanups = new SmallCleanups(entry);
  else if (list instanceof SmallCleanups) {
    if (!unique && list.indexOf(entry) !== -1) return;
    if (list.length < 6) list.set(list.length++, entry);
    else
      state.cleanups = [
        list.get(0),
        list.get(1),
        list.get(2),
        list.get(3),
        list.get(4),
        list.get(5),
        entry,
      ];
  } else if (Array.isArray(list)) {
    if (!unique && list.includes(entry)) return;
    if (!unique && list.length >= 8) state.cleanups = new Set([...list, entry]);
    else list.push(entry);
  } else list.add(entry);
}

function removeCleanup(state: State, entry: CleanupEntry): void {
  const list = state.cleanups;
  if (list instanceof SmallCleanups) list.remove(entry);
  else if (Array.isArray(list)) {
    const index = list.indexOf(entry);
    if (index !== -1) list.splice(index, 1);
  } else list?.delete(entry);
}

/** Internal resources live to teardown and do not need an unregister closure. */
export function ownCleanup(owner: Lifetime, callback: Cleanup): void {
  const state = stateOf(owner);
  if (!state) owner.onCleanup(callback);
  else if (state.closed) callback();
  else addCleanup(state, callback);
}

/** Internal observers already carry their cleanup state; no bound closure is needed. */
export function ownResource(owner: Lifetime, resource: CleanupResource, unique = false): void {
  const state = stateOf(owner);
  if (!state) owner.onCleanup(() => resource[cleanupResource]());
  else if (state.closed) resource[cleanupResource]();
  else addCleanup(state, resource, unique);
}

/** Native nodes participate in the same cleanup order without a closure per node. */
export function ownDOMNode(
  owner: Lifetime,
  node: Node,
  remove: (node: Node) => void,
  unique = false,
): void {
  const state = stateOf(owner);
  if (!state || (state.removeNode && state.removeNode !== remove)) {
    owner.onCleanup(() => remove(node));
  } else if (state.closed) {
    remove(node);
  } else {
    state.removeNode = remove;
    addCleanup(state, node, unique);
  }
}

/**
 * A node placed into `parent`, an element owned by the same lifetime, leaves
 * together with it. It is detached separately only if it was moved elsewhere.
 */
export function ownInnerNode(
  owner: Lifetime,
  node: Node,
  parent: Node,
  remove: (node: Node) => void,
): void {
  const state = stateOf(owner);
  if (!state || (state.removeNode && state.removeNode !== remove)) {
    owner.onCleanup(() => {
      if (node.parentNode !== parent) remove(node);
    });
  } else if (!state.closed) {
    state.removeNode = remove;
    // Starting from an exact pair, the first growth leaves room for a row's
    // worth of nodes (19 slots) instead of 17 and then 41.
    if (state.inner) state.inner.push(node, parent);
    else state.inner = [node, parent];
  }
  // A closed lifetime has already detached `parent`, and this node with it.
}

/**
 * @internal `owner.dispose()` without materializing a lifetime's bound method,
 * nor a promise once a lifetime's teardown finished cleanly.
 */
export function disposeLifetime(owner: Owner): Promise<void> | void {
  const state = stateOf(owner);
  return state ? closeLifetime(state) : owner.dispose();
}

export function lifetime(parent?: Owner): Lifetime {
  return new LifetimeOwner(parent);
}

// Lifetimes, their cleanup lists and teardowns die with the UI they own: keep
// their hidden classes (see `retainShapes`).
retainShapes("ui/lifetime", new LifetimeOwner(), new SmallCleanups(ignore), new Teardown([]));
