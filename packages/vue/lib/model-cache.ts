import type { Scope } from "@virentia/core";
import type { ModelCache, ModelInstance } from "./types";

export function createModelCache<Key, Props, Model extends object>(): ModelCache<
  Key,
  Props,
  Model
> {
  const byScope = new WeakMap<Scope, Map<Key, ModelInstance<Props, Model, Key>>>();
  const maps = new Set<Map<Key, ModelInstance<Props, Model, Key>>>();

  const getScopeMap = (scope: Scope): Map<Key, ModelInstance<Props, Model, Key>> => {
    let map = byScope.get(scope);

    if (!map) {
      map = new Map();
      byScope.set(scope, map);
      maps.add(map);
    }

    return map;
  };

  const find = (key: Key, scope?: Scope): ModelInstance<Props, Model, Key> | undefined => {
    if (scope) {
      return byScope.get(scope)?.get(key);
    }

    for (const map of maps) {
      const instance = map.get(key);

      if (instance) {
        return instance;
      }
    }

    return undefined;
  };

  const cache = {
    has(key: Key, scope?: Scope): boolean {
      return Boolean(find(key, scope));
    },

    get(key: Key, scope?: Scope): Model | undefined {
      return find(key, scope)?.model;
    },

    getInstance(key: Key, scope?: Scope): ModelInstance<Props, Model, Key> | undefined {
      return find(key, scope);
    },

    delete(key: Key, scope?: Scope): boolean {
      if (scope) {
        const map = byScope.get(scope);
        const instance = map?.get(key);

        if (!instance) {
          return false;
        }

        instance.dispose();
        map?.delete(key);
        return true;
      }

      let deleted = false;

      for (const map of maps) {
        const instance = map.get(key);

        if (!instance) {
          continue;
        }

        instance.dispose();
        map.delete(key);
        deleted = true;
      }

      return deleted;
    },

    clear(scope?: Scope): void {
      if (scope) {
        const map = byScope.get(scope);

        if (!map) {
          return;
        }

        for (const instance of map.values()) {
          instance.dispose();
        }

        map.clear();
        return;
      }

      for (const map of maps) {
        for (const instance of map.values()) {
          instance.dispose();
        }

        map.clear();
      }
    },

    [modelCacheInternal](scope: Scope, key: Key, create: () => ModelInstance<Props, Model, Key>) {
      const map = getScopeMap(scope);
      let instance = map.get(key);

      if (!instance) {
        instance = create();
        map.set(key, instance);
      }

      return instance;
    },
  };

  return cache;
}

export function getOrCreateCachedInstance<Props, Key, Model extends object>(
  cache: ModelCache<Key, Props, Model>,
  scope: Scope,
  key: Key,
  create: () => ModelInstance<Props, Model, Key>,
): ModelInstance<Props, Model, Key> {
  const internal = (cache as InternalModelCache<Key, Props, Model>)[modelCacheInternal];

  if (!internal) {
    throw new Error("[useModel] Unsupported model cache. Use createModelCache().");
  }

  return internal(scope, key, create);
}

type InternalModelCache<Key, Props, Model extends object> = ModelCache<Key, Props, Model> & {
  [modelCacheInternal]?: (
    scope: Scope,
    key: Key,
    create: () => ModelInstance<Props, Model, Key>,
  ) => ModelInstance<Props, Model, Key>;
};

const modelCacheInternal = Symbol("virentia.vue.modelCacheInternal");
