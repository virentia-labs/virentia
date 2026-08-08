import { reaction } from "../graph/reaction";
import type { Reaction } from "../graph/reaction";
import type { Scope } from "../scope";
import { event } from "../units/event";
import type { Event } from "../units/event";
import { hasInitialValue, initialValueOf, readonlyStore, store } from "../units/store";
import type { Store, StoreWritable } from "../units/store";
import { derivedName, launch, listen } from "./shared";
import type { UtilSource } from "./shared";

export interface OnceOptions {
  /** Arms the operator again: the next source hit after `reset` passes through. */
  reset?: UtilSource<unknown>;
}

/**
 * Passes the first source hit per scope, swallows the rest until `reset`.
 *
 * The fired flag is a store, deliberately: it is semantic state, so an SSR
 * snapshot carries it — a banner shown on the server does not show again after
 * hydration. A closure `let` here would leak the flag across scopes.
 */
export function once<T>(source: Event<T> | Store<T>, options?: OnceOptions): Event<T> {
  const name = derivedName("once", source);
  const $fired = store(false, undefined, { name: `${name}.fired` });
  const out = event<T>(name);

  listen(source, name, (value, scope) => {
    // Ambient scope inside the reaction body is the firing scope, so the flag
    // reads and writes per scope.
    if ($fired.value) return;

    $fired.value = true;
    launch(out.node, value, scope);
  });

  if (options?.reset) {
    listen(options.reset, `${name}.reset`, () => {
      $fired.value = false;
    });
  }

  return out;
}

export function previous<T>(source: Store<T>): Store<T | undefined>;
export function previous<T, Seed>(source: Store<T>, seed: Seed): Store<T | Seed>;
export function previous<T, Seed>(source: Store<T>, seed?: Seed): Store<T | Seed | undefined> {
  const name = derivedName("previous", source);
  const out = readonlyStore<T | Seed | undefined>(seed, undefined, { name });
  // Per-scope memory of the last committed source value. Not serialized — after
  // SSR hydration the first client-side change falls back to the source's
  // declaration initial (a computed source just keeps the seed then).
  const lastSeen = new WeakMap<Scope, { value: T }>();

  listen(source, name, (value, scope) => {
    const entry = lastSeen.get(scope);

    lastSeen.set(scope, { value });

    if (entry) {
      launch(out.node, entry.value, scope);
    } else if (hasInitialValue(source)) {
      launch(out.node, initialValueOf(source), scope);
    }
  });

  return out;
}

export interface ResetOptions {
  clock: UtilSource<unknown> | readonly UtilSource<unknown>[];
  target: StoreWritable<any> | readonly StoreWritable<any>[];
}

/**
 * Restores every target to its declaration initial when the clock fires — all
 * targets in one transaction, in the firing scope. Targets must be plain
 * writable stores: a computed has no initial to restore (`initialValueOf`
 * throws a naming error at reset time).
 */
export function reset(options: ResetOptions): Reaction {
  const targets = Array.isArray(options.target)
    ? (options.target as readonly StoreWritable<any>[])
    : [options.target as StoreWritable<any>];
  const clocks = Array.isArray(options.clock)
    ? (options.clock as readonly UtilSource<unknown>[])
    : [options.clock as UtilSource<unknown>];

  return reaction({
    name: "reset",
    on: clocks as Event<unknown>[],
    run: () => {
      // Writes inside one reaction body stage into the same transaction and
      // commit together on the drain boundary.
      for (const target of targets) {
        target.value = initialValueOf(target);
      }
    },
  });
}
