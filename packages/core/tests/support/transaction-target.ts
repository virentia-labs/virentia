import { scope, type Scope } from "../../lib";
import {
  exitTransaction,
  readTransactionStore,
  type StoreCommitResult,
  type StoreTransactionTarget,
} from "../../lib/internal";

// `noPendingStoreValue` is not exported. We capture the sentinel by reading an
// id that was never written while no transaction is active — that read returns
// exactly the sentinel. `isSentinel` then compares by identity.
const NO_PENDING: unknown = readTransactionStore(scope(), Symbol("probe.capture"));

export const isSentinel = (value: unknown): boolean => value === NO_PENDING;

// The transaction module keeps `currentTransaction` in module-level state. Call
// this from an afterEach to forcibly unwind any transaction a failing/throwing
// test left open, so it cannot contaminate the next test. exitTransaction is a
// no-op when nothing is active, so an over-long unwind loop is safe.
export function resetTransactions(): void {
  for (let i = 0; i < 64; i += 1) {
    exitTransaction();
  }
}

export interface FakeTarget<T> {
  target: StoreTransactionTarget<T>;
  scope: Scope;
  id: symbol;
  commits: T[];
  /** Value observed at each notify() call, in call order. */
  notifies: T[];
}

export interface FakeTargetOptions<T> {
  scope?: Scope;
  id?: symbol;
  changed?: boolean;
  onCommit?: (value: T) => void;
  onNotify?: (value: T) => void;
  commitResult?: (value: T) => StoreCommitResult;
}

export function makeTarget<T>(options: FakeTargetOptions<T> = {}): FakeTarget<T> {
  const targetScope = options.scope ?? scope();
  const id = options.id ?? Symbol("fake.target");
  const commits: T[] = [];
  const notifies: T[] = [];

  const target: StoreTransactionTarget<T> = {
    id,
    scope: targetScope,
    commit(value: T): StoreCommitResult {
      commits.push(value);
      options.onCommit?.(value);

      if (options.commitResult) {
        return options.commitResult(value);
      }

      return {
        changed: options.changed ?? true,
        notify() {
          notifies.push(value);
          options.onNotify?.(value);
        },
      };
    },
  };

  return { target, scope: targetScope, id, commits, notifies };
}
