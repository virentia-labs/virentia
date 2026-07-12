import { effect, event, reactive, store } from "@virentia/core";
import { describe, expect, it } from "vitest";
import { isPlainObject, isStoreUnit, isUnitLike } from "../../lib/utils";

describe("unit predicates", () => {
  it("distinguishes stores, callables, and plain values", () => {
    const s = store(0);
    const r = reactive({ a: 1 });
    const evt = event<void>();
    const fx = effect(async () => 1);

    expect(isStoreUnit(s)).toBe(true);
    expect(isStoreUnit(r)).toBe(true);
    expect(isStoreUnit(evt)).toBe(false);
    expect(isUnitLike(evt)).toBe(true);
    expect(isUnitLike(fx)).toBe(true);
    expect(isUnitLike({})).toBe(false);
    expect(isUnitLike(() => {})).toBe(false);

    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject(Object.create(null))).toBe(true);
    expect(isPlainObject(new Date())).toBe(false);
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject(null)).toBe(false);
  });
});
