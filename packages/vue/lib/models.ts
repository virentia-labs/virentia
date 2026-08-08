import { collection, queryReactivity, subscribeInstance } from "@virentia/core/models";
import {
  customRef,
  getCurrentScope as getCurrentVueScope,
  onScopeDispose,
  onUnmounted,
  toValue,
  watch,
  type MaybeRefOrGetter,
  type Ref,
} from "vue";
import { useOptionalProvidedScope } from "./scope";

// §10.2, mirror of the React side: `useModel` takes queries, `todos.get(id)`
// results and model definitions (with `keep`). Reactivity rides the core
// seams — query epoch stores and the per-instance change feed.

interface ModelEntity {
  readonly id: string;
  readonly alive: boolean;
  dispose(): void;
}

export interface ModelScreenOptions {
  keep?: boolean;
}

/** Query view: a Ref over the (interned, memoised) query — templates read
 * `query.value.items` / `.count`; unchanged results keep referential identity. */
export function useModelQuery<Q extends object>(query: Q): Readonly<Ref<Q>> {
  const { versions } = queryReactivity(query);
  let unsubscribes: Array<() => void> | null = null;
  let disposed = false;

  const state = customRef<Q>((track, trigger) => ({
    get() {
      track();

      if (!disposed && !unsubscribes) {
        unsubscribes = versions.map((unit) =>
          (unit as { subscribe(listener: () => void): () => void }).subscribe(() => trigger()),
        );
      }

      return query;
    },

    set() {
      // a query view is read-only
    },
  }));

  if (getCurrentVueScope()) {
    onScopeDispose(() => {
      disposed = true;

      for (const unsubscribe of unsubscribes ?? []) unsubscribe();
    });
  }

  return state as Readonly<Ref<Q>>;
}

/** Entity view: follows the instance's own writes, rebind and dispose;
 * resolves to null once the instance is gone — no throw mid-render (§10.1). */
export function useModelEntity<I extends object>(instance: I | null): Readonly<Ref<I | null>> {
  let unsubscribe: (() => void) | null = null;
  let disposed = false;

  const state = customRef<I | null>((track, trigger) => ({
    get() {
      track();

      if (!disposed && !unsubscribe && instance) {
        unsubscribe = subscribeInstance(instance, () => trigger());
      }

      return instance && (instance as unknown as ModelEntity).alive ? instance : null;
    },

    set() {
      // an entity view is read-only
    },
  }));

  if (getCurrentVueScope()) {
    onScopeDispose(() => {
      disposed = true;
      unsubscribe?.();
    });
  }

  return state as Readonly<Ref<I | null>>;
}

interface ScreenCollection {
  readonly count: number;
  readonly first: (ModelEntity & Record<string, unknown>) | null;
  add(input: Record<string, unknown>): ModelEntity & Record<string, unknown>;
}

/** Screen model: `useModel(OrderScreen, props, { keep })` — created through
 * the definition's collection, props re-merged reactively, disposed on
 * unmount unless `keep`; a `controlled` instance skips all ownership. */
export function useModelScreen(
  definition: object,
  props: MaybeRefOrGetter<Record<string, unknown> | undefined> | undefined,
  options: ModelScreenOptions | undefined,
  controlled?: object | null,
): Readonly<Ref<object | null>> {
  const keep = options?.keep === true;
  let instance: ModelEntity & Record<string, unknown>;
  let home: ScreenCollection | null = null;

  if (controlled) {
    instance = controlled as ModelEntity & Record<string, unknown>;
  } else {
    const scope = useOptionalProvidedScope();

    if (!scope) {
      throw new Error(
        "[useProvidedScope] Scope is not provided. Wrap your tree with ScopeProvider.",
      );
    }

    home = collection(definition as never, scope) as unknown as ScreenCollection;
    instance = acquireScreenInstance(home, toValue(props), keep);
  }

  if (home) {
    const homeRef = home;

    // props re-merge reactively: present keys are authoritative (§3.1)
    watch(
      () => toValue(props),
      (next) => {
        if (!instance.alive) return;

        homeRef.add({ ...(next ?? {}), id: instance.id });
      },
      { deep: true },
    );
  }

  if (!keep && !controlled) {
    onUnmounted(() => {
      if (instance.alive) instance.dispose();
    });
  }

  return useModelEntity(instance);
}

function acquireScreenInstance(
  home: ScreenCollection,
  props: Record<string, unknown> | undefined,
  keep: boolean,
): ModelEntity & Record<string, unknown> {
  const input = { ...(props ?? {}) };
  const propsId = typeof input.id === "string" ? (input.id as string) : undefined;

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
