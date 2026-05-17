import type { Scope } from "../scope";

export interface StoreCommitResult {
  changed: boolean;
  notify(): void;
}

export interface StoreTransactionTarget<T = unknown> {
  id: symbol;
  scope: Scope;
  commit(value: T): StoreCommitResult;
}

interface PendingStoreWrite<T = unknown> {
  target: StoreTransactionTarget<T>;
  value: T;
}

interface KernelTransaction {
  depth: number;
  writes: WeakMap<Scope, Map<symbol, PendingStoreWrite>>;
  scopes: Scope[];
}

const noPendingStoreValue = Symbol("virentia.noPendingStoreValue");

let currentTransaction: KernelTransaction | null = null;

export function enterTransaction(): void {
  if (currentTransaction) {
    currentTransaction.depth += 1;
    return;
  }

  currentTransaction = {
    depth: 1,
    writes: new WeakMap(),
    scopes: [],
  };
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

export function commitActiveTransaction(): void {
  if (!currentTransaction) return;

  const depth = currentTransaction.depth;
  const transaction = currentTransaction;

  currentTransaction = {
    depth,
    writes: new WeakMap(),
    scopes: [],
  };

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
    withTransaction(() => writeTransactionStore(target, value));
    return;
  }

  let scopeWrites = currentTransaction.writes.get(target.scope);

  if (!scopeWrites) {
    scopeWrites = new Map();
    currentTransaction.writes.set(target.scope, scopeWrites);
    currentTransaction.scopes.push(target.scope);
  }

  const pending = scopeWrites.get(target.id);

  if (pending) {
    pending.value = value;
  } else {
    scopeWrites.set(target.id, { target, value });
  }
}

export function readTransactionStore<T>(scope: Scope, id: symbol): T | typeof noPendingStoreValue {
  const pending = currentTransaction?.writes.get(scope)?.get(id);

  return pending ? (pending.value as T) : noPendingStoreValue;
}

export function isPendingStoreValue(value: unknown): boolean {
  return value !== noPendingStoreValue;
}

function commitTransaction(transaction: KernelTransaction): void {
  const notifications: (() => void)[] = [];

  for (const scope of transaction.scopes) {
    const scopeWrites = transaction.writes.get(scope);

    if (!scopeWrites) continue;

    for (const pending of scopeWrites.values()) {
      const result = pending.target.commit(pending.value);

      if (result.changed) {
        notifications.push(result.notify);
      }
    }
  }

  for (const notify of notifications) {
    notify();
  }
}
