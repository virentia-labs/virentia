import { onCleanup } from "../graph/owner";
import type { Scope } from "../scope";
import { event } from "../units/event";
import type { Event, EventCallable } from "../units/event";
import { hasInitialValue, initialValueOf, readonlyStore } from "../units/store";
import type { Store } from "../units/store";
import { derivedName, isStoreSource, launch, listen, timerBag } from "./shared";
import type { UtilSource } from "./shared";

// Time operators preserve the kind of their source: an Event in, an Event out;
// a Store in, a Store out (holding the last settled value). The derived store's
// initial is the source's declaration initial — a fresh scope reads the same
// value from both; a scope written to before the operator settles catches up
// one window later. A computed source has no stored initial, so the derived
// store starts `undefined` until the first settle.
//
// Timers are per-scope: activity in one scope never delays or flushes another.
// The settled tail is a detached root launch — awaiting the source does NOT
// include it, and failures downstream of the derived unit are reported through
// the contained-error funnel (never an unhandled rejection). Disposing the
// owner the operator was created under cancels every pending timer.

export interface DebounceOptions {
  ms: number;
  /** Fire the first hit immediately, then stay silent until a full pause. */
  leading?: boolean;
}

export interface ThrottleOptions {
  ms: number;
  /** Also fire immediately when a window opens (the trailing hit still fires). */
  leading?: boolean;
}

export function debounce<T>(source: Store<T>, ms: number | DebounceOptions): Store<T>;
export function debounce<T>(source: Event<T>, ms: number | DebounceOptions): Event<T>;
export function debounce<T>(source: UtilSource<T>, msOrOptions: number | DebounceOptions) {
  const options = typeof msOrOptions === "number" ? { ms: msOrOptions } : msOrOptions;
  const name = derivedName("debounce", source);
  const out = createOutlet(source, name);
  const timers = timerBag();

  listen(source, name, (value, scope) => {
    if (options.leading) {
      // First hit of a busy period fires through; every hit reschedules the
      // pause detector, so the next "first" needs a full quiet window.
      if (!timers.has(scope)) out.fire(value, scope);
      timers.replace(scope, options.ms, () => {});
      return;
    }

    timers.replace(scope, options.ms, () => out.fire(value, scope));
  });

  return out.unit;
}

export function throttle<T>(source: Store<T>, ms: number | ThrottleOptions): Store<T>;
export function throttle<T>(source: Event<T>, ms: number | ThrottleOptions): Event<T>;
export function throttle<T>(source: UtilSource<T>, msOrOptions: number | ThrottleOptions) {
  const options = typeof msOrOptions === "number" ? { ms: msOrOptions } : msOrOptions;
  const name = derivedName("throttle", source);
  const out = createOutlet(source, name);
  const timers = timerBag();
  const windows = new WeakMap<Scope, { latest: T; hasLatest: boolean }>();

  const closeWindow = (scope: Scope): void => {
    const win = windows.get(scope);

    // A trailing hit is an emission, so it opens a cooldown window of its own —
    // two emissions are never closer than `ms`, leading or not.
    if (win?.hasLatest) {
      const value = win.latest;

      win.hasLatest = false;
      out.fire(value, scope);
      timers.replace(scope, options.ms, () => closeWindow(scope));
    }
  };

  listen(source, name, (value, scope) => {
    if (!timers.has(scope)) {
      if (options.leading) {
        windows.set(scope, { latest: value, hasLatest: false });
        out.fire(value, scope);
      } else {
        windows.set(scope, { latest: value, hasLatest: true });
      }

      timers.replace(scope, options.ms, () => closeWindow(scope));
      return;
    }

    windows.set(scope, { latest: value, hasLatest: true });
  });

  return out.unit;
}

export function delay<T>(source: Store<T>, ms: number): Store<T>;
export function delay<T>(source: Event<T>, ms: number): Event<T>;
export function delay<T>(source: UtilSource<T>, ms: number) {
  const name = derivedName("delay", source);
  const out = createOutlet(source, name);
  const timers = timerBag();

  listen(source, name, (value, scope) => {
    // Every hit is shifted independently — no collapsing, order preserved.
    timers.add(ms, () => out.fire(value, scope));
  });

  return out.unit;
}

export interface IntervalOptions {
  ms: number;
  start: Event<any>;
  stop?: Event<any>;
  /** Tick once immediately on start, then every `ms`. */
  leading?: boolean;
}

export interface IntervalHandle {
  readonly tick: Event<void>;
  /** Per-scope: `true` between `start` and `stop` in that scope. */
  readonly active: Store<boolean>;
}

export function interval(options: IntervalOptions): IntervalHandle {
  const tick = event<void>("interval.tick");
  const active = readonlyStore(false, undefined, { name: "interval.active" });
  const timers = timerBag();

  // Registered after the bag, so it runs BEFORE the bag's cancel-all (cleanups
  // are LIFO): every scope still ticking gets `active = false` on dispose.
  onCleanup(() => {
    for (const scope of timers.scopes()) {
      launch(active.node, false, scope);
    }
  });

  const loop = (scope: Scope): void => {
    timers.replace(scope, options.ms, () => {
      launch(tick.node, undefined, scope);
      loop(scope);
    });
  };

  listen(options.start, "interval.start", (_value, scope) => {
    // `start` while running is a no-op — it neither resets the phase nor
    // double-schedules.
    if (timers.has(scope)) return;

    launch(active.node, true, scope);

    if (options.leading) launch(tick.node, undefined, scope);

    loop(scope);
  });

  if (options.stop) {
    listen(options.stop, "interval.stop", (_value, scope) => {
      if (!timers.has(scope)) return;

      timers.cancel(scope);
      launch(active.node, false, scope);
    });
  }

  return { tick, active };
}

// The Event-or-Store outlet behind every time operator: a derived event fired
// into the scope, or a derived readonly store written in the scope through its
// node (the same idiom effect bookkeeping uses).
function createOutlet<T>(
  source: UtilSource<T>,
  name: string,
): { unit: Event<T> | Store<T>; fire(value: T, scope: Scope): void } {
  if (isStoreSource(source)) {
    const initial = hasInitialValue(source) ? initialValueOf(source) : (undefined as T);
    const out = readonlyStore<T>(initial, undefined, { name });

    return { unit: out, fire: (value, scope) => launch(out.node, value, scope) };
  }

  const out: EventCallable<T> = event<T>(name);

  return { unit: out, fire: (value, scope) => launch(out.node, value, scope) };
}
