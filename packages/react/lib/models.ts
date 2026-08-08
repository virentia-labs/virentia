import { collection, queryReactivity, subscribeInstance } from "@virentia/core/models";
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { useOptionalProvidedScope } from "./scope";
import { useIsomorphicLayoutEffect } from "./utils";

// §10.1 for @virentia/core/models: no new hooks — `useModel` (and `component`)
// accept queries, instances and model definitions. Reactivity comes from the
// core seams: query epochs (plan-memoised results keep referential identity,
// so an unchanged result never re-renders) and the per-instance change feed.

interface ModelEntity {
  readonly id: string;
  readonly alive: boolean;
  dispose(): void;
}

export interface ModelScreenOptions {
  keep?: boolean;
}

/** Query view: `useModel(todos.where(...).sort(...).take(50))`. The chain may
 * be rebuilt every render — plans are interned, results memoised (§8). */
export function useModelQuery<Q extends object>(query: Q): Q {
  const { versions } = queryReactivity(query);
  const stableVersions = useStableArray(versions);

  const subscribe = useCallback(
    (notify: () => void) => {
      const unsubscribes = stableVersions.map((unit) =>
        (unit as { subscribe(listener: () => void): () => void }).subscribe(notify),
      );

      return () => {
        for (const unsubscribe of unsubscribes) unsubscribe();
      };
    },
    [stableVersions],
  );

  // The snapshot IS the result identity: an epoch bump that does not change
  // the set keeps the same array, and React skips the re-render.
  const getSnapshot = useCallback(() => (query as { items: unknown[] }).items, [query]);

  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  return query;
}

/** Entity view: `useModel(todos.get(id))`. Re-renders on the instance's own
 * writes, rebind and dispose; resolves to null once the instance is gone. */
export function useModelEntity<I extends object>(instance: I | null): I | null {
  const revisionRef = useRef(0);

  const subscribe = useCallback(
    (notify: () => void) => {
      if (!instance) return () => {};

      return subscribeInstance(instance, () => {
        revisionRef.current += 1;
        notify();
      });
    },
    [instance],
  );

  const getSnapshot = useCallback(() => revisionRef.current, []);

  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  if (!instance) return null;

  return (instance as unknown as ModelEntity).alive ? instance : null;
}

/** Screen model: `useModel(OrderScreen, props, { keep })`. The definition is
 * already a `props → instance` factory through its collection (§10.1). A
 * `controlled` instance (from `component.create()`) skips creation, prop
 * merging and disposal — its lifetime belongs to whoever created it. */
export function useModelScreen(
  definition: object,
  props: Record<string, unknown> | undefined,
  options: ModelScreenOptions | undefined,
  controlled?: object | null,
): object | null {
  const scope = useOptionalProvidedScope();
  const keep = options?.keep === true;
  const home = useMemo(() => {
    if (controlled) return null;

    if (!scope) {
      throw new Error(
        "[useProvidedScope] Scope is not provided. Wrap your tree with ScopeProvider.",
      );
    }

    return collection(definition as never, scope) as unknown as ScreenCollection;
  }, [controlled, definition, scope]);
  const propsId = typeof props?.id === "string" ? (props.id as string) : undefined;
  const instance = useMemo(
    () =>
      (controlled as (ModelEntity & Record<string, unknown>) | null | undefined) ??
      acquireScreenInstance(home!, props, keep, propsId),
    [controlled, home, keep, propsId],
  );

  useScreenPropsMerge(home, instance, controlled ? undefined : props);
  useScreenLifecycle(instance, keep || Boolean(controlled));

  return useModelEntity(instance);
}

interface ScreenCollection {
  readonly count: number;
  readonly first: (ModelEntity & Record<string, unknown>) | null;
  add(input: Record<string, unknown>): ModelEntity & Record<string, unknown>;
}

function acquireScreenInstance(
  home: ScreenCollection,
  props: Record<string, unknown> | undefined,
  keep: boolean,
  propsId: string | undefined,
): ModelEntity & Record<string, unknown> {
  const input = { ...(props ?? {}) };

  // an id in the props targets that instance — get-or-create, merge (§3.1)
  if (propsId !== undefined || !keep) return home.add(input);

  // keep without an id: the per-scope singleton; several live instances make
  // the choice ambiguous — a dev error, not a silent pick (§10.1)
  if (home.count > 1) {
    throw new Error(
      "[useModel] keep without an id is ambiguous — the model has several live instances; pass the instance id (§10.1)",
    );
  }

  const existing = home.first;

  if (existing) return home.add({ ...input, id: existing.id });

  return home.add(input);
}

/** Props re-merge reactively: present keys are authoritative, a merge is an
 * `add({ id, ...props })` upsert; unchanged props write nothing. */
function useScreenPropsMerge(
  home: ScreenCollection | null,
  instance: ModelEntity,
  props: Record<string, unknown> | undefined,
): void {
  const lastRef = useRef<Record<string, unknown> | undefined>(undefined);

  useIsomorphicLayoutEffect(() => {
    if (!home || !instance.alive) return;
    if (shallowEqualRecords(lastRef.current, props)) return;

    lastRef.current = props;
    home.add({ ...(props ?? {}), id: instance.id });
  });
}

/** Unmount disposes unless `keep` — `keep` changes exactly one thing: the
 * owner of the end of life (§10.1). StrictMode-safe via deferred dispose. */
function useScreenLifecycle(instance: ModelEntity, keep: boolean): void {
  const mountCountsRef = useRef<WeakMap<object, number> | null>(null);

  if (mountCountsRef.current === null) {
    mountCountsRef.current = new WeakMap<object, number>();
  }

  const mountCounts = mountCountsRef.current;

  useEffect(() => {
    mountCounts.set(instance, (mountCounts.get(instance) ?? 0) + 1);

    return () => {
      mountCounts.set(instance, Math.max(0, (mountCounts.get(instance) ?? 1) - 1));

      if (!keep) {
        queueMicrotask(() => {
          if ((mountCounts.get(instance) ?? 0) === 0 && instance.alive) {
            instance.dispose();
          }
        });
      }
    };
  }, [instance, keep, mountCounts]);
}

function useStableArray<T>(next: readonly T[]): readonly T[] {
  const ref = useRef(next);

  if (
    ref.current.length !== next.length ||
    next.some((value, index) => value !== ref.current[index])
  ) {
    ref.current = next;
  }

  return ref.current;
}

function shallowEqualRecords(
  a: Record<string, unknown> | undefined,
  b: Record<string, unknown> | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;

  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);

  if (aKeys.length !== bKeys.length) return false;

  return aKeys.every((key) => a[key] === b[key]);
}
