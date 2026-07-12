import { reactive, scope, scoped, store, type Store } from "@virentia/core";
import { describe, expect, it } from "vitest";
import { readStore } from "../../lib/utils";

describe("readStore", () => {
  it("returns the raw value for a primitive store", () => {
    const sc = scope();
    const count = store(5);
    expect(readStore(count as unknown as Store<number>, sc)).toBe(5);
  });

  it("returns a fromEntries snapshot of non-native keys for an object reactive", () => {
    const sc = scope();
    const r = reactive({ x: 1, y: { z: 2 } });
    expect(readStore(r as never, sc)).toEqual({ x: 1, y: { z: 2 } });
  });

  it("returns an Array.from snapshot for an array reactive", () => {
    const sc = scope();
    const a = reactive([1, 2, 3]);
    const snap = readStore(a as never, sc);
    expect(Array.isArray(snap)).toBe(true);
    expect(snap).toEqual([1, 2, 3]);
  });

  it("does not treat an object with a non-numeric key as an array despite a length field", () => {
    const sc = scope();
    const r = reactive({ length: 2, foo: "x" } as Record<string, unknown>);
    const snap = readStore(r as never, sc);
    expect(Array.isArray(snap)).toBe(false);
    expect(snap).toEqual({ length: 2, foo: "x" });
  });

  it("reflects the target scope's state rather than the default", () => {
    const scopeA = scope();
    const scopeB = scope();
    const s = store(0);
    scoped(scopeA, () => (s.value = 11));
    scoped(scopeB, () => (s.value = 22));
    expect(readStore(s as unknown as Store<number>, scopeA)).toBe(11);
    expect(readStore(s as unknown as Store<number>, scopeB)).toBe(22);
  });

  // SUSPECTED BUG: a reactive field named like a StoreApi member (map/node/...)
  // makes the proxy `ownKeys` return duplicate keys, so readStore throws instead
  // of returning the snapshot. Correct behaviour would retain the field.
  it.fails("reads a reactive field whose name collides with a native store key", () => {
    const sc = scope();
    const r = reactive({ map: 5, value: 10 } as Record<string, unknown>);
    expect(readStore(r as never, sc)).toEqual({ map: 5, value: 10 });
  });
});
