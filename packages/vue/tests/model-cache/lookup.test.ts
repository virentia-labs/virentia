// @vitest-environment happy-dom

import { scope, type Store } from "@virentia/core";
import { setActiveScope } from "@virentia/core/internal";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createModelCache } from "../../lib";
import { getOrCreateCachedInstance } from "../../lib/model-cache";
import { makeInstance } from "../support/cache-instance";
import { unmountAll } from "../support/mount";

beforeEach(() => {
  setActiveScope(null);
});

afterEach(() => {
  unmountAll();
  setActiveScope(null);
});

describe("createModelCache", () => {
  it("resolves has, get, and getInstance both scoped and cross-scope", () => {
    const cache = createModelCache<string, object, { count: Store<number> }>();
    const scopeA = scope();
    const scopeB = scope();

    const instA = getOrCreateCachedInstance(cache, scopeA, "k", () => makeInstance(scopeA, "k"));

    expect(cache.has("k", scopeA)).toBe(true);
    expect(cache.get("k", scopeA)).toBe(instA.model);
    expect(cache.getInstance("k", scopeA)).toBe(instA);

    // Cross-scope find (no scope) locates it via the Set-tracked maps.
    expect(cache.has("k")).toBe(true);
    expect(cache.getInstance("k")).toBe(instA);

    // Wrong scope / missing key.
    expect(cache.has("k", scopeB)).toBe(false);
    expect(cache.getInstance("missing", scopeA)).toBeUndefined();

    cache.clear();
  });

  it("rejects a foreign cache object lacking the internal symbol", () => {
    const scopeA = scope();
    const foreign = {
      has: () => false,
      get: () => undefined,
      getInstance: () => undefined,
      delete: () => false,
      clear: () => {},
    } as unknown as ReturnType<typeof createModelCache<string, object, { count: Store<number> }>>;

    expect(() =>
      getOrCreateCachedInstance(foreign, scopeA, "k", () => makeInstance(scopeA, "k")),
    ).toThrow("[useModel] Unsupported model cache. Use createModelCache().");
  });

  it("returns the same cached instance on repeated get-or-create", () => {
    const cache = createModelCache<string, object, { count: Store<number> }>();
    const scopeA = scope();

    const first = getOrCreateCachedInstance(cache, scopeA, "k", () => makeInstance(scopeA, "k"));
    let secondFactoryRan = false;
    const second = getOrCreateCachedInstance(cache, scopeA, "k", () => {
      secondFactoryRan = true;
      return makeInstance(scopeA, "k");
    });

    expect(second).toBe(first);
    expect(secondFactoryRan).toBe(false);

    cache.clear();
  });
});
