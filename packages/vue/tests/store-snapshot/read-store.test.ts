// @vitest-environment happy-dom

import { reactive, scope, store } from "@virentia/core";
import { setActiveScope } from "@virentia/core/internal";
import { flushPromises } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Ref } from "vue";
import { bindUnit } from "../../lib/use-unit";
import { readStore, writeStore } from "../../lib/utils";
import { unmountAll } from "../support/mount";

beforeEach(() => {
  setActiveScope(null);
});

afterEach(() => {
  unmountAll();
  setActiveScope(null);
});

describe("readStore", () => {
  it("returns the raw value for a primitive store", () => {
    const appScope = scope();
    const s = store(5);

    expect(readStore(s, appScope)).toBe(5);
  });

  it("rebuilds an array reactive as a real Array", () => {
    const appScope = scope();
    const arr = reactive([10, 20, 30]);

    const snapshot = readStore(arr, appScope) as number[];

    expect(Array.isArray(snapshot)).toBe(true);
    expect(snapshot).toEqual([10, 20, 30]);
    expect(snapshot.length).toBe(3);
  });

  it("exposes an array reactive as an Array through a useUnit binding", () => {
    const appScope = scope();
    const arr = reactive([1, 2]);

    const bound = bindUnit(arr, appScope) as Ref<number[]>;

    expect(Array.isArray(bound.value)).toBe(true);
    expect(bound.value).toEqual([1, 2]);
  });

  it("excludes native store keys when snapshotting an object reactive", () => {
    const appScope = scope();
    const user = reactive({ name: "Ada", age: 36 });

    const snapshot = readStore(user, appScope) as Record<string, unknown>;

    expect(snapshot).toEqual({ name: "Ada", age: 36 });
    for (const nativeKey of ["node", "subscribe", "writable", "map", "filter", "filterMap"]) {
      expect(nativeKey in snapshot).toBe(false);
    }
  });

  it("produces a fresh object reference on each update with latest-wins", async () => {
    const appScope = scope();
    const user = reactive({ n: 1 });

    const bound = bindUnit(user, appScope) as Ref<{ n: number }>;
    const first = bound.value;
    expect(first).toEqual({ n: 1 });

    writeStore(user, { n: 2 }, appScope);
    writeStore(user, { n: 3 }, appScope);
    await flushPromises();

    expect(bound.value).toEqual({ n: 3 });
    // shallowRef with a fresh snapshot each read -> a new reference.
    expect(bound.value).not.toBe(first);
  });
});
