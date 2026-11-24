import { getActiveScope, setActiveScope } from "./internal";
import type { Scope } from "./types";
import { getOwner, setOwner, type Owner } from "../graph/owner";

interface Resume {
  readonly scope: Scope | null;
  readonly owner: Owner | null;
  readonly run: () => void;
}

const resumes: Resume[] = [];
let resumeHead = 0;
let scheduled = false;

// A native await continuation is queued by its resolve callback. Deliver one
// continuation per microtask turn, then release its context before delivering
// the next one. Installing scope in Promise.finally is insufficient: two ready
// promises can otherwise overwrite each other's scope before either await runs.
function scheduleResume(scope: Scope | null, owner: Owner | null, run: () => void): void {
  resumes.push({ scope, owner, run });
  if (scheduled) return;
  scheduled = true;
  // Kernel continuations restore their own synchronous frame. The first
  // handoff can use this promise job; subsequent handoffs still wait until the
  // preceding native await continuation has run and released its context.
  resumeNext();
}

function resumeNext(): void {
  deliverResume(resumes[resumeHead++]);
}

function deliverResume(next: Resume): void {
  const previous = setActiveScope(next.scope);
  const previousOwner = setOwner(next.owner);
  next.run();
  queueMicrotask(() => {
    setActiveScope(previous);
    setOwner(previousOwner);
    if (resumeHead < resumes.length) queueMicrotask(resumeNext);
    else {
      resumes.length = 0;
      resumeHead = 0;
      scheduled = false;
    }
  });
}

function resolveImmediately(resolve: (value: any) => void): void {
  resolve(undefined);
}

function settleWith<T>(
  source: PromiseLike<T>,
): (resolve: (value: T) => void, reject: (reason: unknown) => void) => void {
  return (resolve, reject) => {
    // Wrapping a library promise to hand it back to a DIFFERENT caller must
    // not first schedule the old caller's context. Only the outer direct await
    // resumes user code; the inner handoff is promise bookkeeping.
    if (source instanceof ScopedPromise) Promise.prototype.then.call(source, resolve, reject);
    else Promise.resolve(source).then(resolve, reject);
  };
}

// Await invokes .then on a Promise subclass (unlike an intrinsic Promise).
// Chained ordinary promises deliberately remain ordinary: only a direct await
// of a Virentia callable promises to resume in its caller's context.
class ScopedPromise<T> extends Promise<T> {
  readonly #immediate: boolean;
  static get [Symbol.species](): PromiseConstructor {
    return Promise;
  }

  constructor(
    source: PromiseLike<T> | void,
    private readonly resumeScope: Scope | null,
    private readonly resumeOwner: Owner | null,
  ) {
    const immediate =
      source === undefined || (source instanceof ScopedPromise && source.#immediate);
    // No closure here: it would make every call allocate the constructor's context.
    super(immediate ? resolveImmediately : settleWith(source!));
    this.#immediate = immediate;
  }

  override then<TResult1 = T, TResult2 = never>(
    fulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
    rejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return new Promise<TResult1 | TResult2>((resolve, reject) => {
      const deliver = (
        callback: () => TResult1 | TResult2 | PromiseLike<TResult1 | TResult2>,
      ): void => {
        scheduleResume(this.resumeScope, this.resumeOwner, () => {
          try {
            resolve(callback());
          } catch (error) {
            reject(error);
          }
        });
      };
      super.then(
        (value) => deliver(() => (fulfilled ? fulfilled(value) : (value as unknown as TResult1))),
        (error: unknown) =>
          deliver(() => {
            if (rejected) return rejected(error);
            throw error;
          }),
      );
    });
  }
}

/** @internal Context handoff for direct awaits of library-owned async units. */
export function scopePromise<T>(
  source: PromiseLike<T> | void,
  scope: Scope | null = getActiveScope(),
  owner: Owner | null = getOwner(),
): Promise<T> {
  return new ScopedPromise(source, scope, owner);
}
