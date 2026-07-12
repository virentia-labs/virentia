import {
  event,
  reaction,
  scope,
  scoped,
  store,
  type EventCallable,
  type Scope,
  type Store,
} from "@virentia/core";
import { describe, expect, it } from "vitest";
import { createModelCache } from "../../lib";
import { createModelInstance } from "../../lib/use-model";
import { getOrCreateCachedInstance } from "../../lib/model-cache";

function cacheableInstance(sc: Scope) {
  const bump = event<void>();
  const count = store(0);
  const create = () =>
    createModelInstance(
      () => {
        reaction({ on: bump, run: () => (count.value += 1) });
        return { bump, count };
      },
      {},
      sc,
      "k",
    );
  return { bump, count, create };
}

describe("model cache", () => {
  it("creates the instance once and returns it on repeat lookups", () => {
    const sc = scope();
    const cache = createModelCache<string, object, { bump: EventCallable<void>; count: Store<number> }>();
    const { create } = cacheableInstance(sc);
    const first = getOrCreateCachedInstance(cache, sc, "k", create);
    const second = getOrCreateCachedInstance(cache, sc, "k", create);
    expect(first).toBe(second);
    cache.clear();
  });

  it("yields distinct instances for the same key under two scopes", () => {
    const scopeA = scope();
    const scopeB = scope();
    const cache = createModelCache<string, object, { bump: EventCallable<void>; count: Store<number> }>();
    const a = getOrCreateCachedInstance(cache, scopeA, "k", cacheableInstance(scopeA).create);
    const b = getOrCreateCachedInstance(cache, scopeB, "k", cacheableInstance(scopeB).create);
    expect(a).not.toBe(b);
    expect(cache.getInstance("k", scopeA)).toBe(a);
    expect(cache.getInstance("k", scopeB)).toBe(b);
    cache.clear();
  });

  it("returns the cached model from get and the instance from getInstance on a scope-less lookup", () => {
    const scopeA = scope();
    const scopeB = scope();
    const cache = createModelCache<string, object, { bump: EventCallable<void>; count: Store<number> }>();
    const a = getOrCreateCachedInstance(cache, scopeA, "k", cacheableInstance(scopeA).create);

    expect(cache.has("k")).toBe(true);
    expect(cache.get("k")).toBe(a.model);
    expect(cache.getInstance("k")).toBe(a);
    // wrong scope -> miss
    expect(cache.has("k", scopeB)).toBe(false);
    expect(cache.get("k", scopeB)).toBeUndefined();
    cache.clear();
  });

  it("disposes the instance on delete(key, scope) and returns false on a second delete", async () => {
    const sc = scope();
    const cache = createModelCache<string, object, { bump: EventCallable<void>; count: Store<number> }>();
    const { bump, count, create } = cacheableInstance(sc);
    getOrCreateCachedInstance(cache, sc, "k", create);

    await scoped(sc, () => bump());
    scoped(sc, () => expect(count.value).toBe(1));

    expect(cache.delete("k", sc)).toBe(true);
    expect(cache.has("k", sc)).toBe(false);

    // reaction disposed: further dispatches are no-ops
    await scoped(sc, () => bump());
    scoped(sc, () => expect(count.value).toBe(1));

    expect(cache.delete("k", sc)).toBe(false);
  });

  it("purges every scope map when delete(key) omits the scope", () => {
    const scopeA = scope();
    const scopeB = scope();
    const cache = createModelCache<string, object, { bump: EventCallable<void>; count: Store<number> }>();
    getOrCreateCachedInstance(cache, scopeA, "k", cacheableInstance(scopeA).create);
    getOrCreateCachedInstance(cache, scopeB, "k", cacheableInstance(scopeB).create);

    expect(cache.delete("k")).toBe(true);
    expect(cache.has("k", scopeA)).toBe(false);
    expect(cache.has("k", scopeB)).toBe(false);
    expect(cache.delete("k")).toBe(false);
  });

  it("clears a single scope with clear(scope) and all scopes with clear()", () => {
    const scopeA = scope();
    const scopeB = scope();
    const cache = createModelCache<string, object, { bump: EventCallable<void>; count: Store<number> }>();
    getOrCreateCachedInstance(cache, scopeA, "k", cacheableInstance(scopeA).create);
    getOrCreateCachedInstance(cache, scopeB, "k", cacheableInstance(scopeB).create);

    cache.clear(scopeA);
    expect(cache.has("k", scopeA)).toBe(false);
    expect(cache.has("k", scopeB)).toBe(true);

    cache.clear();
    expect(cache.has("k", scopeB)).toBe(false);
  });

  it("throws for an unsupported cache object", () => {
    const sc = scope();
    expect(() =>
      getOrCreateCachedInstance({} as any, sc, "k", () => ({}) as any),
    ).toThrow("[useModel] Unsupported model cache. Use createModelCache().");
  });
});
