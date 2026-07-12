// @vitest-environment happy-dom

import { scope, scoped, store, type Store } from "@virentia/core";
import { setActiveScope } from "@virentia/core/internal";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createModelCache } from "../../lib";
import { getOrCreateCachedInstance } from "../../lib/model-cache";
import { createModelInstance } from "../../lib/use-model";
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
  it("returns false for a missing key yet disposes the instance on a hit", () => {
    const cache = createModelCache<string, object, { count: Store<number> }>();
    const scopeA = scope();

    expect(cache.delete("missing", scopeA)).toBe(false);

    let disposed = false;
    getOrCreateCachedInstance(cache, scopeA, "k", () => makeInstance(scopeA, "k", () => (disposed = true)));

    expect(cache.delete("k", scopeA)).toBe(true);
    expect(disposed).toBe(true);
    expect(cache.has("k", scopeA)).toBe(false);
  });

  it("removes a matching key across all scopes when called without a scope", () => {
    const cache = createModelCache<string, object, { count: Store<number> }>();
    const scopeA = scope();
    const scopeB = scope();
    let disposedA = false;
    let disposedB = false;

    getOrCreateCachedInstance(cache, scopeA, "shared", () =>
      makeInstance(scopeA, "shared", () => (disposedA = true)),
    );
    getOrCreateCachedInstance(cache, scopeB, "shared", () =>
      makeInstance(scopeB, "shared", () => (disposedB = true)),
    );

    expect(cache.delete("shared")).toBe(true);
    expect(disposedA).toBe(true);
    expect(disposedB).toBe(true);
    expect(cache.has("shared")).toBe(false);
  });

  it("removes only the target scope while cross-scope find resolves the sibling", () => {
    const cache = createModelCache<string, object, { count: Store<number> }>();
    const scopeA = scope();
    const scopeB = scope();

    const instA = getOrCreateCachedInstance(cache, scopeA, "k", () =>
      scoped(scopeA, () => createModelInstance(() => ({ count: store(0) }), {}, scopeA, "k")),
    );
    const instB = getOrCreateCachedInstance(cache, scopeB, "k", () =>
      scoped(scopeB, () => createModelInstance(() => ({ count: store(0) }), {}, scopeB, "k")),
    );

    expect(cache.delete("k", scopeA)).toBe(true);
    expect(cache.has("k", scopeA)).toBe(false);
    // scopeB survives; scope-less find now resolves the remaining sibling.
    expect(cache.getInstance("k", scopeB)).toBe(instB);
    expect(cache.getInstance("k")).toBe(instB);
    expect(instA).not.toBe(instB);

    cache.clear();
    expect(cache.has("k")).toBe(false);
  });
});
