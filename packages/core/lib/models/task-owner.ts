import type { Owner } from "../graph/owner";
import { retainShapes } from "../kernel/shapes";

/** Model tasks share methods; a read-only computed needs no cleanup array. */
export class ModelTaskOwner implements Owner {
  disposed = false;
  #cleanups?: (() => void)[];
  #boundDispose?: () => void;
  #boundCleanup?: Owner["onCleanup"];
  #boundSymbolDispose?: () => void;

  get dispose(): () => void {
    return (this.#boundDispose ??= this.#dispose.bind(this));
  }
  set dispose(callback: () => void) {
    replaceMethod(this, "dispose", callback);
  }
  get onCleanup(): Owner["onCleanup"] {
    return (this.#boundCleanup ??= this.#onCleanup.bind(this));
  }
  set onCleanup(callback: Owner["onCleanup"]) {
    replaceMethod(this, "onCleanup", callback);
  }
  get [Symbol.dispose](): () => void {
    return (this.#boundSymbolDispose ??= this.#disposeSymbol.bind(this));
  }
  set [Symbol.dispose](callback: () => void) {
    replaceMethod(this, Symbol.dispose, callback);
  }
  #disposeSymbol(): void {
    this.dispose();
  }
  #onCleanup(callback: () => void): () => void {
    if (this.disposed) {
      callback();
      return noop;
    }
    (this.#cleanups ??= []).push(callback);
    return () => {
      const index = this.#cleanups?.indexOf(callback) ?? -1;
      if (index >= 0) this.#cleanups!.splice(index, 1);
    };
  }
  #dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const cleanups = this.#cleanups;
    this.#cleanups = undefined;
    let thrown: unknown;
    if (cleanups)
      for (let index = cleanups.length - 1; index >= 0; index--) {
        try {
          cleanups[index]();
        } catch (error) {
          thrown ??= error;
        }
      }
    if (thrown) throw thrown;
  }
}

function noop(): void {}
function replaceMethod(target: Owner, key: PropertyKey, callback: Function): void {
  Object.defineProperty(target, key, {
    value: callback,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

// A model's task owner dies with it: keep its hidden class (see kernel/shapes.ts).
retainShapes("core/models/task-owner", new ModelTaskOwner());
