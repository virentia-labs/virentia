import { describe, expect, it } from "vitest";
import { computed, scope, scoped, store } from "../../lib";
import { NativeModelScope, type ComputedStateCache } from "../../lib/scope/native";

const cacheOf = (s: object): ComputedStateCache =>
  (s as NativeModelScope).computedStates as ComputedStateCache;

describe("root scope computed state cache", () => {
  it("serves the same state objects the scope's value map holds, across many computeds", () => {
    const app = scope(),
      source = store(1);
    // More computeds than the initial table has entries: collisions grow it.
    const derived = Array.from({ length: 1500 }, (_, index) =>
      computed(() => source.value + index),
    );
    const sum = computed(() => derived.reduce((total, unit) => total + unit.value, 0));
    const expected = (base: number) => 1500 * base + (1500 * 1499) / 2;
    expect(scoped(app, () => sum.value)).toBe(expected(1));
    expect(cacheOf(app).entries.length).toBeGreaterThan(256);
    scoped(app, () => {
      source.value = 5;
    });
    expect(scoped(app, () => sum.value)).toBe(expected(5));
    for (const [index, unit] of derived.entries()) {
      const id = (unit.node as unknown as { valueKey: symbol }).valueKey;
      const state = app.values.get(id) as { value: number; slot: number };
      expect(state.value).toBe(5 + index);
      // Whatever the cache holds for a computed is its value-map entry.
      const entry = cacheOf(app).entries[state.slot & cacheOf(app).mask];
      if (entry?.slot === state.slot) expect(entry).toBe(state);
    }
  });

  it("keeps scopes apart and leaves model and plain scopes on their value maps", () => {
    const a = scope(),
      b = scope(),
      source = store(1),
      doubled = computed(() => source.value * 2);
    scoped(b, () => {
      source.value = 10;
    });
    expect(scoped(a, () => doubled.value)).toBe(2);
    expect(scoped(b, () => doubled.value)).toBe(20);
    const plain = { values: new Map(), handlers: new Map(), deps: new Map() };
    expect(scoped(plain, () => doubled.value)).toBe(2);
    expect((plain as Partial<NativeModelScope>).computedStates).toBeUndefined();
  });

  it("forgets a released computed's state", () => {
    const app = scope(),
      source = store(3),
      tripled = computed(() => source.value * 3);
    expect(scoped(app, () => tripled.value)).toBe(9);
    const core = tripled.node as unknown as { valueKey: symbol; computedSlot: number };
    const cache = cacheOf(app);
    expect(cache.entries[core.computedSlot & cache.mask]).toBe(app.values.get(core.valueKey));
    app.values.delete(core.valueKey);
    NativeModelScope.forgetComputedState(app, core);
    expect(cache.entries[core.computedSlot & cache.mask]).toBeUndefined();
    expect(scoped(app, () => tripled.value)).toBe(9);
    expect(cache.entries[core.computedSlot & cache.mask]).toBe(app.values.get(core.valueKey));
  });
});
