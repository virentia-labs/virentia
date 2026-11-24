import type { Scope } from "../scope";
import { retainShapes } from "./shapes";
import { NativeModelScope, type StagedScopeWrites } from "../scope/native";

export interface StoreCommitResult {
  changed: boolean;
  notify(): void;
}

export interface StoreTransactionTarget<T = unknown> {
  id: symbol;
  scope: Scope;
  commit(value: T): StoreCommitResult;
}

/** @internal The commit half of a native store, and its staging slot. */
export interface NativeStoreCommitter<T> {
  readonly valueKey: symbol;
  /** The store's latest staged write (see StagedNativeWrite); stale once its transaction ended. */
  staged: StagedNativeWrite<unknown> | undefined;
  commitState(scope: Scope, value: T, previous: unknown, had: boolean): boolean;
  /** Commits `value`, known to change the store and not to be its skip token. */
  commitValue(scope: Scope, value: T): void;
  /** Whether committing `value` over `previous` (absent unless `had`) changes the store. */
  changedFrom(previous: unknown, had: boolean, value: T): boolean;
  publishState(scope: Scope, value: T): void;
}

/** @internal One native write: the store, its scope and the commit protocol. */
export class NativeStoreTransactionTarget<T> implements StoreTransactionTarget<T> {
  // Assigned rather than declared as fields: see StagedNativeWrite.
  declare readonly id: symbol;
  declare readonly scope: Scope;
  declare readonly store: NativeStoreCommitter<T>;
  constructor(id: symbol, scope: Scope, store: NativeStoreCommitter<T>) {
    (this as { id: symbol }).id = id;
    (this as { scope: Scope }).scope = scope;
    (this as { store: NativeStoreCommitter<T> }).store = store;
  }
  write(scope: Scope, value: T, previous: unknown, had: boolean): boolean {
    return this.store.commitState(scope, value, previous, had);
  }
  publish(scope: Scope, value: T): void {
    this.store.publishState(scope, value);
  }
  commit(value: T): StoreCommitResult {
    const previous = this.scope.values.get(this.id);
    const changed = this.write(
      this.scope,
      value,
      previous,
      previous !== undefined || this.scope.values.has(this.id),
    );
    return {
      changed,
      notify: () => {
        if (changed) this.publish(this.scope, value);
      },
    };
  }
}

/** @internal A write staged in a transaction. */
export interface PendingStoreWrite<T = unknown> {
  target: StoreTransactionTarget<T>;
  value: T;
  had?: boolean;
  previous?: unknown;
  notify?: () => void;
  changed?: boolean;
}

interface KernelTransaction {
  depth: number;
  scope: Scope | null;
  /** The first scope's writes, in staging order. */
  writes: PendingStoreWrite[] | null;
  /**
   * Other scopes written, in the order each was first written. Each keeps the
   * transaction's writes to it in its own slot (see `scopeWrites`), cleared
   * when the transaction commits.
   */
  others: Scope[] | null;
  /** Writes by scope and id: built only once a write is looked up by id. */
  index: Map<Scope, Map<symbol, PendingStoreWrite>> | null;
  epoch: number;
  /**
   * What writes committed at once (`commitUnobservedWrite`) replaced, as
   * scope, id, value triples: a failed commit of the transaction restores them.
   */
  replaced: unknown[] | null;
}

/**
 * @internal A native store's write staged in a transaction. It is its own
 * commit target, and its store points at its latest one, so staging a write and
 * reading it back need no lookup table. A store written in several scopes of
 * one transaction (a model field across instances) marks its writes `shared`:
 * those of other scopes are found through their scope's list of writes.
 */
export class StagedNativeWrite<T> extends NativeStoreTransactionTarget<T> {
  // Declared, then assigned in the constructor: initializers of a derived
  // class's fields run as a separate step after `super`, which costs about as
  // much again as the allocation, and one is made per write.
  declare readonly target: StagedNativeWrite<T>;
  declare value: T;
  declare had: boolean | undefined;
  declare previous: unknown;
  declare notify: (() => void) | undefined;
  declare changed: boolean;
  /**
   * Committed when written (see `applyNativeWrite`): `previous` and `had` are
   * what the transaction found, and only its publication waits for the commit.
   */
  declare applied: boolean;
  declare readonly transaction: KernelTransaction;
  declare readonly shared: boolean;

  constructor(
    id: symbol,
    scope: Scope,
    store: NativeStoreCommitter<T>,
    value: T,
    transaction: KernelTransaction,
    shared: boolean,
  ) {
    super(id, scope, store);
    (this as { target: StagedNativeWrite<T> }).target = this;
    this.value = value;
    this.had = undefined;
    this.previous = undefined;
    this.notify = undefined;
    this.changed = false;
    this.applied = false;
    (this as { transaction: KernelTransaction }).transaction = transaction;
    (this as { shared: boolean }).shared = shared;
  }
}

const noPendingStoreValue = Symbol("virentia.noPendingStoreValue");

let currentTransaction: KernelTransaction | null = null;
function transactionFrame(depth: number): KernelTransaction {
  return {
    depth,
    scope: null,
    // Created by the first write: most drains stage nothing.
    writes: null,
    others: null,
    index: null,
    epoch: 0,
    replaced: null,
  };
}

// Targets and staged writes are created per write and die young: keep their
// hidden classes, and the optimized commit code built on them (see
// kernel/shapes.ts).
const retainedScope: Scope = { values: new Map(), handlers: new Map(), deps: new Map() };
const retainedStore: NativeStoreCommitter<unknown> = {
  valueKey: Symbol("virentia.retainedShape"),
  staged: undefined,
  commitState: () => false,
  commitValue() {},
  changedFrom: () => false,
  publishState() {},
};
retainShapes(
  "core/kernel/transaction",
  new NativeStoreTransactionTarget(Symbol("virentia.retainedShape"), retainedScope, retainedStore),
  new StagedNativeWrite(
    Symbol("virentia.retainedShape"),
    retainedScope,
    retainedStore,
    undefined,
    transactionFrame(0),
    false,
  ),
);
// Identifies the store update currently being published. It advances the moment
// a new value is STAGED — that is when readers start seeing it, well before the
// commit — and stays put through the commit and the propagation that follows.
// Derived units record the epoch they were first materialized in, which is how
// a value that predates the update is told apart from one a read created in the
// middle of it.
let updateEpoch = 0;

export function currentUpdateEpoch(): number {
  return updateEpoch;
}

export function beginUpdateEpoch(): number {
  updateEpoch += 1;

  return updateEpoch;
}

export function enterTransaction(): void {
  if (currentTransaction) {
    currentTransaction.depth += 1;
    return;
  }

  currentTransaction = transactionFrame(1);
}

export function exitTransaction(): void {
  if (!currentTransaction) return;

  currentTransaction.depth -= 1;

  if (currentTransaction.depth > 0) {
    return;
  }

  const transaction = currentTransaction;
  currentTransaction = null;
  commitTransaction(transaction);
}

/** Depth of the open transaction (0 when none). 1 means the outermost. */
export function activeTransactionDepth(): number {
  return currentTransaction ? currentTransaction.depth : 0;
}

/** @internal A suspended depth-zero frame still owns its staged writes. */
export function hasStoreTransaction(): boolean {
  return currentTransaction !== null;
}

export function commitActiveTransaction(): void {
  if (!currentTransaction) return;

  const depth = currentTransaction.depth;
  const transaction = currentTransaction;

  currentTransaction = transactionFrame(depth);

  commitTransaction(transaction);
}

export function withTransaction<T>(fn: () => T): T {
  enterTransaction();

  try {
    return fn();
  } finally {
    exitTransaction();
  }
}

export function writeTransactionStore<T>(target: StoreTransactionTarget<T>, value: T): void {
  if (!currentTransaction) {
    if (target instanceof NativeStoreTransactionTarget) {
      writeNativeStore(target.store, target.id, target.scope, value);
      return;
    }
    enterTransaction();
    try {
      writeTransactionStore(target, value);
    } finally {
      exitTransaction();
    }
    return;
  }

  if (target instanceof NativeStoreTransactionTarget) {
    stageNativeWrite(target.store, target.id, target.scope, value);
    return;
  }

  const transaction = currentTransaction;
  // One epoch per transaction: a batch of writes that commits together is a
  // single update, so everything staged in it shares one identity.
  if (transaction.epoch === 0) {
    transaction.epoch = beginUpdateEpoch();
  }

  const pending = writeIndex(transaction).get(target.scope)?.get(target.id);

  if (pending) {
    pending.value = value;
  } else {
    appendWrite(transaction, target.scope, {
      target,
      value,
      had: undefined,
      previous: undefined,
      notify: undefined,
      changed: false,
    });
  }
}

/**
 * @internal Commit a write nobody observes at once instead of staging it: at
 * commit there would be no one to notify, and reads in the transaction see
 * the same value. False when the store already has a write staged in this
 * transaction, which keeps its order. A failed commit restores the value.
 * `current` is the store's value in `scope` (it differs from `value`, which
 * is not the skip token).
 */
export function commitUnobservedWrite<T>(
  store: NativeStoreCommitter<T>,
  id: symbol,
  scope: Scope,
  value: T,
  current: T,
  initial: T,
): boolean {
  const transaction = currentTransaction!;
  if (store.staged?.transaction === transaction) return false;
  if (transaction.epoch === 0) transaction.epoch = beginUpdateEpoch();
  // Nothing is staged: `current` was read from the scope's map, or is the
  // initial value of a store that has none there.
  const had = !Object.is(current, initial) || scope.values.has(id);
  store.commitValue(scope, value);
  (transaction.replaced ??= []).push(scope, id, had ? current : noPendingStoreValue);
  return true;
}

/**
 * @internal Commit a native write in the open transaction at once; only its
 * publication waits for the transaction's commit. Reads in the transaction see
 * the same value as through a staged write, and the commit needs no lookup of
 * the value it replaces. `current` is the store's value in `scope` (it differs
 * from `value`). False when the store has a write staged in this transaction
 * that is not applied, or in another scope: that write keeps its order.
 */
export function applyNativeWrite<T>(
  store: NativeStoreCommitter<T>,
  id: symbol,
  scope: Scope,
  value: T,
  current: T,
  initial: T,
): boolean {
  const transaction = currentTransaction!;
  const latest = store.staged;
  if (latest !== undefined && latest.transaction === transaction) {
    if (!latest.applied || latest.scope !== scope) return false;
    store.commitValue(scope, value);
    latest.value = value;
    return true;
  }
  if (transaction.epoch === 0) transaction.epoch = beginUpdateEpoch();
  // A value other than the initial one was read from the scope's map.
  const had = !Object.is(current, initial) || scope.values.has(id);
  store.commitValue(scope, value);
  const write = new StagedNativeWrite(id, scope, store, value, transaction, false);
  write.applied = true;
  write.previous = current;
  write.had = had;
  store.staged = write as StagedNativeWrite<unknown>;
  appendWrite(transaction, scope, write as PendingStoreWrite);
  return true;
}

/** A further write to a staged one: an applied write commits it at once too. */
function restage<T>(write: StagedNativeWrite<T>, value: T): void {
  if (write.applied) write.store.commitState(write.scope, value, write.value, true);
  write.value = value;
}

/** @internal Stage a native store's write in the open transaction. */
export function stageNativeWrite<T>(
  store: NativeStoreCommitter<T>,
  id: symbol,
  scope: Scope,
  value: T,
): void {
  const transaction = currentTransaction!;
  if (transaction.epoch === 0) {
    transaction.epoch = beginUpdateEpoch();
  }

  const latest = store.staged;
  let shared = false;
  if (latest !== undefined && latest.transaction === transaction) {
    if (latest.scope === scope) {
      restage(latest, value);
      return;
    }
    const existing = latest.shared ? stagedInScope(transaction, scope, store) : undefined;
    if (existing) {
      restage(existing, value);
      return;
    }
    shared = true;
  }

  const write = new StagedNativeWrite(id, scope, store, value, transaction, shared);
  store.staged = write as StagedNativeWrite<unknown>;
  appendWrite(transaction, scope, write as PendingStoreWrite);
}

const stagedFallback = new WeakMap<Scope, StagedScopeWrites>();
/** The writes `transaction` staged in `scope`. */
function scopeWrites(
  transaction: KernelTransaction,
  scope: Scope,
): PendingStoreWrite[] | null | undefined {
  if (transaction.scope === scope) return transaction.writes;
  return transaction.others
    ? (NativeModelScope.stagedWrites(scope, transaction, stagedFallback) as
        | PendingStoreWrite[]
        | undefined)
    : undefined;
}

/** A shared store's write staged for `scope`: found in that scope's (short) list. */
function stagedInScope(
  transaction: KernelTransaction,
  scope: Scope,
  store: NativeStoreCommitter<unknown>,
): StagedNativeWrite<unknown> | undefined {
  const writes = scopeWrites(transaction, scope);
  if (!writes) return undefined;
  if (writes.length > 8) {
    const write = writeIndex(transaction).get(scope)?.get(store.valueKey);
    return write instanceof StagedNativeWrite ? write : undefined;
  }
  for (const write of writes)
    if (write instanceof StagedNativeWrite && write.store === store) return write;
  return undefined;
}

function appendWrite(transaction: KernelTransaction, scope: Scope, write: PendingStoreWrite): void {
  if (transaction.scope === scope) transaction.writes!.push(write);
  else if (!transaction.scope) {
    transaction.scope = scope;
    transaction.writes = [write];
  } else {
    const writes = transaction.others
      ? (NativeModelScope.stagedWrites(scope, transaction, stagedFallback) as
          | PendingStoreWrite[]
          | undefined)
      : undefined;
    if (writes) writes.push(write);
    else {
      NativeModelScope.stageWrites(scope, transaction, [write], stagedFallback);
      (transaction.others ??= []).push(scope);
    }
  }
  if (transaction.index) indexWrite(transaction.index, scope, write);
}

function writeIndex(transaction: KernelTransaction): Map<Scope, Map<symbol, PendingStoreWrite>> {
  let index = transaction.index;
  if (index) return index;
  index = transaction.index = new Map();
  if (transaction.writes)
    for (const write of transaction.writes) indexWrite(index, transaction.scope!, write);
  if (transaction.others)
    for (const scope of transaction.others)
      for (const write of scopeWrites(transaction, scope)!) indexWrite(index, scope, write);
  return index;
}

function indexWrite(
  index: Map<Scope, Map<symbol, PendingStoreWrite>>,
  scope: Scope,
  write: PendingStoreWrite,
): void {
  let writes = index.get(scope);
  if (!writes) index.set(scope, (writes = new Map()));
  writes.set(write.target.id, write);
}

/** @internal Write a native store: staged in the open transaction, else committed now. */
export function writeNativeStore<T>(
  store: NativeStoreCommitter<T>,
  id: symbol,
  scope: Scope,
  value: T,
): void {
  if (currentTransaction) {
    stageNativeWrite(store, id, scope, value);
    return;
  }
  const previous = scope.values.get(id),
    had = previous !== undefined || scope.values.has(id);
  writeKnownNativeStore(store, id, scope, value, previous, had);
}

/** @internal No callbacks occur between a native writer's read and this commit. */
export function writeKnownNativeStore<T>(
  store: NativeStoreCommitter<T>,
  id: symbol,
  scope: Scope,
  value: T,
  previous: unknown,
  had: boolean,
): void {
  if (currentTransaction) {
    stageNativeWrite(store, id, scope, value);
    return;
  }
  // One native write is already an atomic commit. It needs neither a staging
  // list nor a notification queue; notifications still run only after the
  // value has committed, outside the transaction frame.
  beginUpdateEpoch();
  let changed: boolean;
  try {
    changed = store.commitState(scope, value, previous, had);
  } catch (error) {
    if (had) scope.values.set(id, previous);
    else scope.values.delete(id);
    throw error;
  }
  if (changed) store.publishState(scope, value);
}

/** @internal The value a native store has staged in the open transaction for `scope`. */
export function readStagedStore<T>(
  store: NativeStoreCommitter<T>,
  scope: Scope,
): T | typeof noPendingStoreValue {
  const latest = store.staged;
  if (latest === undefined || latest.transaction !== currentTransaction) return noPendingStoreValue;
  if (latest.scope === scope) return latest.value as T;
  const write = latest.shared
    ? stagedInScope(latest.transaction, scope, store as NativeStoreCommitter<unknown>)
    : undefined;
  return write ? (write.value as T) : noPendingStoreValue;
}

export function readTransactionStore<T>(scope: Scope, id: symbol): T | typeof noPendingStoreValue {
  const transaction = currentTransaction;
  if (!transaction?.scope) return noPendingStoreValue;
  const pending = writeIndex(transaction).get(scope)?.get(id);

  return pending ? (pending.value as T) : noPendingStoreValue;
}

export function isPendingStoreValue(value: unknown): boolean {
  return value !== noPendingStoreValue;
}

/** @internal Include staged native values whose defaults have no physical Map entry yet. */
export function copyPendingStoreValues(scope: Scope, target: Map<unknown, unknown>): void {
  const writes = currentTransaction && scopeWrites(currentTransaction, scope);
  if (!writes) return;
  for (const pending of writes) {
    if (pending.target instanceof NativeStoreTransactionTarget)
      target.set(pending.target.id, pending.value);
  }
}

type NativeBatchPublisher = (scope: Scope, writes: readonly PendingStoreWrite[]) => boolean;
let nativeBatchPublisher: NativeBatchPublisher | undefined;
// Set while a commit publishes several targets one by one.
let publishingSeveral = false;
/** @internal Whether the commit being published has more than one target. */
export function isPublishingSeveral(): boolean {
  return publishingSeveral;
}
/** @internal Stores install the synchronous propagation for committed batches. */
export function setNativeBatchPublisher(publisher: NativeBatchPublisher): void {
  nativeBatchPublisher = publisher;
}

function commitTransaction(transaction: KernelTransaction): void {
  if (!transaction.scope) return;
  let committed = transaction.writes!;
  if (transaction.others) {
    committed = committed.slice();
    for (const scope of transaction.others) {
      for (const write of scopeWrites(transaction, scope)!) committed.push(write);
      NativeModelScope.stageWrites(scope, undefined, undefined, stagedFallback);
    }
  }

  // Writes whose previous value was captured: what a failure has to revert.
  let captured = 0;
  // Changed native writes, for the batch publisher; -1 once another changed.
  let changedNative = 0;
  try {
    for (let index = 0; index < committed.length; index++) {
      const pending = committed[index];
      // Only a native write staged in a transaction is its own target.
      if (pending.target === (pending as unknown) && (pending as StagedNativeWrite<unknown>).applied) {
        // Committed when written: it changed the store if the value it leaves
        // differs from the one the transaction found.
        const applied = pending as StagedNativeWrite<unknown>;
        if (applied.store.staged?.transaction === transaction) applied.store.staged = undefined;
        if ((pending.changed = applied.store.changedFrom(applied.previous, applied.had!, applied.value)))
          if (changedNative >= 0) changedNative++;
        captured = index + 1;
        continue;
      }
      const { scope: targetScope, id } = pending.target;

      // Snapshot the pre-commit value so the whole commit phase can roll back
      // atomically if a later commit throws.
      pending.previous = targetScope.values.get(id);
      pending.had = pending.previous !== undefined || targetScope.values.has(id);
      captured = index + 1;

      if (pending.target instanceof NativeStoreTransactionTarget) {
        const target = pending.target as NativeStoreTransactionTarget<unknown>;
        // Readers no longer see staged writes; let the store drop this one.
        if (target.store.staged?.transaction === transaction) target.store.staged = undefined;
        if ((pending.changed = target.write(targetScope, pending.value, pending.previous, pending.had)))
          if (changedNative >= 0) changedNative++;
      } else {
        const result = pending.target.commit(pending.value);
        pending.changed = result.changed;
        if (result.changed) {
          pending.notify = result.notify;
          changedNative = -1;
        }
      }
    }
  } catch (error) {
    // Atomicity: a failed commit reverts every store already committed in this
    // transaction and runs no notifications — the transaction does not apply.
    for (let i = captured - 1; i >= 0; i -= 1) {
      const entry = committed[i];
      const { scope, id } = entry.target;

      if (entry.had) {
        scope.values.set(id, entry.previous);
      } else {
        scope.values.delete(id);
      }
    }
    for (let i = committed.length - 1; i >= captured; i--) {
      const target = committed[i].target;
      if (
        target instanceof NativeStoreTransactionTarget &&
        target.store.staged?.transaction === transaction
      )
        target.store.staged = undefined;
      // Committed when written: restore what the transaction found.
      if (target instanceof StagedNativeWrite && target.applied) {
        if (target.had) target.scope.values.set(target.id, target.previous);
        else target.scope.values.delete(target.id);
      }
    }
    // Writes committed at once, newest first: the oldest restores the value
    // the transaction started from.
    const replaced = transaction.replaced;
    if (replaced)
      for (let i = replaced.length - 3; i >= 0; i -= 3) {
        const scope = replaced[i] as Scope,
          id = replaced[i + 1] as symbol,
          previous = replaced[i + 2];
        if (previous === noPendingStoreValue) scope.values.delete(id);
        else scope.values.set(id, previous);
      }

    throw error;
  }

  // Every commit succeeded, so the state is applied. Run every notification even
  // if one throws (a throwing subscriber must not skip the others), then surface
  // the first error.
  let notifyError: unknown;
  let hasNotifyError = false;

  // An idle drain's commit of several native stores in one scope: the
  // publisher may notify every subscriber and then propagate once.
  if (
    nativeBatchPublisher &&
    !transaction.others &&
    changedNative > 1 &&
    nativeBatchPublisher(transaction.scope, committed)
  )
    return;

  const several = publishingSeveral;
  publishingSeveral = committed.length > 1;
  try {
    for (const pending of committed) {
      if (!pending.changed) continue;
      try {
        if (pending.target instanceof NativeStoreTransactionTarget)
          pending.target.publish(pending.target.scope, pending.value);
        else pending.notify!();
      } catch (error) {
        if (!hasNotifyError) {
          hasNotifyError = true;
          notifyError = error;
        }
      }
    }
  } finally {
    publishingSeveral = several;
  }

  if (hasNotifyError) {
    throw notifyError;
  }
}
