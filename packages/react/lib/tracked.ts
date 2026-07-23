import { scoped, type Scope } from "@virentia/core";
import { useCallback, useMemo, useRef, useSyncExternalStore } from "react";
import type { AnyStore, UnitLike } from "./types";
import { getShape, isStoreUnit, isUnitLike, readStore } from "./utils";

// The instance handle a `component()`-built model carries. Kept here (not in
// use-model) so the tracked walkers can recognise a nested ComponentModel and
// pass it through untouched without importing use-model (which would cycle).
export const modelInstanceSymbol = Symbol("virentia.react.modelInstance");

export function isComponentModel(value: unknown): boolean {
  return Boolean(
    value &&
    typeof value === "object" &&
    (value as Record<PropertyKey, unknown>)[modelInstanceSymbol],
  );
}

// Per-render tracking state shared by every leaf getter of one tracked tree.
// `reads` and `values` are cleared each render (see `useTrackedTree`); `stores`
// is the immutable set of every store leaf in the tree, collected once at build.
export interface TrackContext {
  readonly scope: Scope;
  readonly reads: Set<AnyStore>;
  readonly values: Map<AnyStore, unknown>;
  readonly stores: Set<AnyStore>;
}

// A store field: reading it records the store in `reads` (so a change to it
// re-renders) and returns the live snapshot, memoised within the render so
// repeated reads of one object-valued store keep a stable identity.
export function defineStoreLeaf(
  target: object,
  key: PropertyKey,
  unit: AnyStore,
  ctx: TrackContext,
): void {
  ctx.stores.add(unit);
  Object.defineProperty(target, key, {
    enumerable: true,
    configurable: true,
    get() {
      ctx.reads.add(unit);
      if (ctx.values.has(unit)) {
        return ctx.values.get(unit);
      }
      const value = readStore(unit, ctx.scope);
      ctx.values.set(unit, value);
      return value;
    },
  });
}

export function defineValue(target: object, key: PropertyKey, value: unknown): void {
  Object.defineProperty(target, key, { enumerable: true, configurable: true, value });
}

export function bindCallable(unit: UnitLike, scope: Scope): (...args: any[]) => unknown {
  return (...args: any[]) => scoped(scope, () => (unit as (...rest: any[]) => unknown)(...args));
}

// Guards recursion against a shape that resolves back onto itself. The node is
// tracked along the current path (added on enter, removed on exit), so diamonds
// stay valid and only a genuine cycle throws instead of recursing forever.
export function guardCycle<T>(node: object, seen: WeakSet<object>, visit: () => T): T {
  if (seen.has(node)) {
    throw new Error("[useUnit] Cyclic @@shape: a shape must not resolve back onto itself.");
  }
  seen.add(node);
  try {
    return visit();
  } finally {
    seen.delete(node);
  }
}

// Resolves any container value (array, `@@shape` source, or plain object) into a
// tracked structure whose store leaves are lazy getters. Mirrors the recursion
// of the old `useUnitWithScope`, but builds plain accessors instead of hooks.
export function resolveUnitNode(input: unknown, ctx: TrackContext, seen: WeakSet<object>): unknown {
  if (Array.isArray(input)) {
    return guardCycle(input, seen, () => {
      const result = new Array(input.length);
      input.forEach((element, index) => defineUnitChild(result, index, element, ctx, seen));
      return result;
    });
  }

  // `@@shape` declares the bindable shape of an otherwise opaque value. Units
  // are ruled out by the caller, so `getShape` is safe here.
  const shape = getShape(input);

  if (shape !== undefined) {
    return guardCycle(input as object, seen, () => resolveUnitNode(shape, ctx, seen));
  }

  return guardCycle(input as object, seen, () => {
    const result: Record<PropertyKey, unknown> = {};

    for (const key of Object.keys(input as object)) {
      defineUnitChild(result, key, (input as Record<string, unknown>)[key], ctx, seen);
    }

    return result;
  });
}

function defineUnitChild(
  target: object,
  key: PropertyKey,
  raw: unknown,
  ctx: TrackContext,
  seen: WeakSet<object>,
): void {
  // Units before `getShape`: a reactive store is a Proxy whose arbitrary key
  // reads need an active scope, so `getShape` must never touch one.
  if (isUnitLike(raw)) {
    if (isStoreUnit(raw)) {
      defineStoreLeaf(target, key, raw, ctx);
    } else {
      defineValue(target, key, bindCallable(raw, ctx.scope));
    }
    return;
  }

  if (raw !== null && (typeof raw === "object" || typeof raw === "function")) {
    defineValue(target, key, resolveUnitNode(raw, ctx, seen));
    return;
  }

  // A non-unit leaf is not bindable — shapes carry units only. Pass it through.
  defineValue(target, key, raw);
}

// Top-level walker for `useUnit` shape/object/array inputs.
export function walkUnit(input: unknown, ctx: TrackContext): unknown {
  return resolveUnitNode(input, ctx, new WeakSet<object>());
}

// One `useSyncExternalStore` for a whole tracked tree. It subscribes to every
// store leaf, but a change only re-renders when that leaf was actually read in
// the last render (`reads`) — so a component ignores fields, and sub-model
// stores, it never touches. `walk` must be a stable module-level function.
export function useTrackedTree(
  input: unknown,
  scope: Scope,
  walk: (input: unknown, ctx: TrackContext) => unknown,
): unknown {
  const readsRef = useRef<Set<AnyStore> | null>(null);
  if (readsRef.current === null) {
    readsRef.current = new Set<AnyStore>();
  }
  const reads = readsRef.current;

  const valuesRef = useRef<Map<AnyStore, unknown> | null>(null);
  if (valuesRef.current === null) {
    valuesRef.current = new Map<AnyStore, unknown>();
  }
  const values = valuesRef.current;

  // A fresh render observes a fresh set of reads and store snapshots.
  reads.clear();
  values.clear();

  const versionRef = useRef(0);

  const built = useMemo(() => {
    const stores = new Set<AnyStore>();
    const tree = walk(input, { scope, reads, values, stores });
    return { tree, stores };
  }, [input, scope, reads, values, walk]);

  const subscribe = useCallback(
    (notify: () => void) => {
      const unsubscribes: Array<() => void> = [];

      for (const unit of built.stores) {
        unsubscribes.push(
          unit.subscribe((_value: unknown, nextScope: Scope) => {
            if (nextScope !== scope) {
              return;
            }
            if (!reads.has(unit)) {
              return;
            }
            versionRef.current += 1;
            notify();
          }),
        );
      }

      return () => {
        for (const unsubscribe of unsubscribes) {
          unsubscribe();
        }
      };
    },
    [built, scope, reads],
  );

  const getSnapshot = useCallback(() => versionRef.current, []);

  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  return built.tree;
}
