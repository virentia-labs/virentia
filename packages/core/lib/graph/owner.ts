export interface Owner {
  readonly disposed: boolean;
  [Symbol.dispose](): void;
  dispose(): void;
  onCleanup(fn: Cleanup): () => void;
}

export type Owned<T extends object> = T & DisposableOwner;

export interface DisposableOwner {
  [Symbol.dispose](): void;
  dispose(): void;
}

export type Cleanup = () => void;

let activeOwner: Owner | null = null;

declare global {
  interface SymbolConstructor {
    readonly dispose: symbol;
  }
}

export function owner<T extends object>(fn: (dispose: () => void, owner: Owner) => T): Owned<T>;
export function owner<T>(fn: (dispose: () => void, owner: Owner) => T): T;
export function owner<T>(fn: (dispose: () => void, owner: Owner) => T): T {
  const nextOwner = createOwner();
  const previousOwner = activeOwner;

  activeOwner = nextOwner;

  try {
    return attachDisposableOwner(
      fn(() => nextOwner.dispose(), nextOwner),
      nextOwner,
    );
  } catch (error) {
    try {
      nextOwner.dispose();
    } catch {
      // A cleanup that throws during this rescue dispose must not mask the
      // original error from `fn` — surface `fn`'s error, drop the cleanup's.
    }
    throw error;
  } finally {
    activeOwner = previousOwner;
  }
}

export function getOwner(): Owner | null {
  return activeOwner;
}

export function onCleanup(fn: Cleanup): () => void {
  const owner = activeOwner;

  return owner ? owner.onCleanup(fn) : noop;
}

export function withOwner<T>(owner: Owner | null, fn: () => T): T {
  if (!owner) {
    return fn();
  }

  const previousOwner = activeOwner;
  activeOwner = owner;

  try {
    return fn();
  } finally {
    activeOwner = previousOwner;
  }
}

export function registerCleanup(fn: Cleanup): () => void {
  return onCleanup(fn);
}

interface OwnerState extends Owner {
  disposed: boolean;
  cleanups: Cleanup[];
}

function createOwner(): Owner {
  const owner: OwnerState = {
    disposed: false,
    cleanups: [],

    [Symbol.dispose](): void {
      owner.dispose();
    },

    dispose(): void {
      if (owner.disposed) return;

      owner.disposed = true;
      const cleanups = owner.cleanups;
      owner.cleanups = [];
      let thrown: unknown;

      for (let index = cleanups.length - 1; index >= 0; index -= 1) {
        try {
          cleanups[index]();
        } catch (error) {
          thrown ??= error;
        }
      }

      if (thrown) {
        throw thrown;
      }
    },

    onCleanup(fn: Cleanup): () => void {
      if (owner.disposed) {
        fn();
        return noop;
      }

      owner.cleanups.push(fn);

      return () => {
        const index = owner.cleanups.indexOf(fn);

        if (index >= 0) {
          owner.cleanups.splice(index, 1);
        }
      };
    },
  };

  defineDisposableProperty(owner, disposeSymbol, () => owner.dispose());

  return owner;
}

function attachDisposableOwner<T>(value: T, owner: Owner): T {
  if (!isObject(value)) {
    return value;
  }

  defineDisposableProperty(value, "dispose", () => owner.dispose());
  defineDisposableProperty(value, disposeSymbol, () => owner.dispose());

  return value;
}

function defineDisposableProperty(target: object, key: PropertyKey, dispose: () => void): void {
  if (key in target) {
    return;
  }

  Object.defineProperty(target, key, {
    configurable: true,
    value: dispose,
  });
}

function isObject(value: unknown): value is object {
  return (typeof value === "object" || typeof value === "function") && value !== null;
}

function noop(): void {}

const disposeSymbol = getDisposeSymbol();

function getDisposeSymbol(): typeof Symbol.dispose {
  if (typeof Symbol.dispose === "symbol") {
    return Symbol.dispose;
  }

  const symbol = Symbol.for("Symbol.dispose");

  try {
    Object.defineProperty(Symbol, "dispose", {
      configurable: true,
      value: symbol,
    });
  } catch {
    // Some runtimes may not allow patching globals. The fallback symbol still works
    // for transpiled `using` helpers and for Virentia's own disposable objects.
  }

  return symbol as unknown as typeof Symbol.dispose;
}
