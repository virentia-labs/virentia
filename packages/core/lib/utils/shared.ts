import { runDetached } from "../kernel";
import type { Node } from "../kernel";
import { readInspectorNodeMeta } from "../kernel/inspector";
import { onCleanup } from "../graph/owner";
import { reaction } from "../graph/reaction";
import type { Reaction } from "../graph/reaction";
import type { Scope } from "../scope";
import type { Event } from "../units/event";
import type { Store } from "../units/store";

export type UtilSource<T> = Event<T> | Store<T>;

// One listening path for every source kind: an explicit reaction fires per
// event call and per store change alike, in the firing scope, with its ambient
// scope installed for the callback's own reads and writes. The cast erases the
// Event/Store split only for overload resolution — payload typing stays exact.
export function listen<T>(
  source: UtilSource<T>,
  name: string,
  fn: (value: T, scope: Scope) => void,
): Reaction {
  return reaction({
    name,
    on: source as Event<T>,
    run: (value, api) => fn(value, api.scope),
  });
}

// Fire a derived unit in a concrete scope. Works from anywhere — a timer
// callback with no ambient scope, or inside a reaction body (where it joins the
// current drain reentrantly, same transaction). `runDetached` absorbs failures
// already delivered through the contained-error funnel and reports the rest, so
// no operator ever leaks an unhandled rejection.
export function launch(node: Node, payload: unknown, scope: Scope): void {
  runDetached({ unit: node, payload, scope });
}

// `debounce(search)` in the inspector instead of an anonymous unit — but only
// when the source is named; an unnamed source keeps the bare operator name.
export function derivedName(operator: string, source: { node: Node }): string {
  const name = readInspectorNodeMeta(source.node).name;

  return typeof name === "string" && name.length > 0 ? `${operator}(${name})` : operator;
}

export function isStoreSource(source: UtilSource<unknown>): source is Store<unknown> {
  return typeof (source as { subscribe?: unknown }).subscribe === "function";
}

export interface TimerBag {
  /** Schedule the scope's single timer, replacing a pending one (debounce/throttle window). */
  replace(scope: Scope, ms: number, fire: () => void): void;
  /** Is a timer pending for this scope? */
  has(scope: Scope): boolean;
  /** Cancel the scope's pending timer, if any. */
  cancel(scope: Scope): void;
  /** Schedule an independent one-shot alongside others (delay: no collapsing). */
  add(ms: number, fire: () => void): void;
  /** Scopes with a pending per-scope timer (for teardown bookkeeping). */
  scopes(): Iterable<Scope>;
}

// One bag per operator instance. Timer handles are per-scope non-state — never
// serialized, entries exist only while a timer is pending. The bag hooks into
// the owner the operator was created under: dispose cancels every pending timer
// across all scopes, so nothing fires after teardown. A global operator (no
// owner) lives forever, like any global unit.
export function timerBag(): TimerBag {
  const perScope = new Map<Scope, () => void>();
  const loose = new Set<() => void>();

  onCleanup(() => {
    for (const cancel of perScope.values()) cancel();
    for (const cancel of loose) cancel();
    perScope.clear();
    loose.clear();
  });

  return {
    replace(scope, ms, fire) {
      perScope.get(scope)?.();

      const timer = setTimeout(() => {
        perScope.delete(scope);
        fire();
      }, ms);

      perScope.set(scope, () => clearTimeout(timer));
    },

    has(scope) {
      return perScope.has(scope);
    },

    cancel(scope) {
      perScope.get(scope)?.();
      perScope.delete(scope);
    },

    add(ms, fire) {
      const timer = setTimeout(() => {
        loose.delete(cancel);
        fire();
      }, ms);
      const cancel = (): void => clearTimeout(timer);

      loose.add(cancel);
    },

    scopes() {
      return perScope.keys();
    },
  };
}
