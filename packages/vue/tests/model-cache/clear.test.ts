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
  it("disposes a single scope on clear(scope) then everything on clear()", () => {
    const cache = createModelCache<string, object, { count: Store<number> }>();
    const scopeA = scope();
    const scopeB = scope();
    let disposedA = false;
    let disposedB = false;

    getOrCreateCachedInstance(cache, scopeA, "a", () =>
      makeInstance(scopeA, "a", () => (disposedA = true)),
    );
    getOrCreateCachedInstance(cache, scopeB, "b", () =>
      makeInstance(scopeB, "b", () => (disposedB = true)),
    );

    cache.clear(scopeA);
    expect(disposedA).toBe(true);
    expect(disposedB).toBe(false);
    expect(cache.has("a", scopeA)).toBe(false);
    expect(cache.has("b", scopeB)).toBe(true);

    cache.clear();
    expect(disposedB).toBe(true);
    expect(cache.has("b", scopeB)).toBe(false);
  });
});
