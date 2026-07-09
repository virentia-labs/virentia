import { describe, expect, it } from "vitest";
import { computed, reaction, scope, scoped, store } from "../../lib";
import { run } from "../../lib/internal";
import { flush } from "../support/store-helpers";

describe("computed", () => {
  it("does not run its function until the first read", () => {
    const sc = scope();
    let calls = 0;
    const c = computed(() => {
      calls += 1;
      return 42;
    });

    expect(calls).toBe(0);
    scoped(sc, () => {
      expect(c.value).toBe(42);
    });
    expect(calls).toBe(1);
  });

  it("caches its value until a dependency changes", () => {
    const appScope = scope();
    const count = store(1);
    let calls = 0;
    const doubled = computed(() => {
      calls += 1;
      return count.value * 2;
    });

    expect(calls).toBe(0);

    scoped(appScope, () => {
      expect(doubled.value).toBe(2);
      expect(doubled.value).toBe(2);
    });
    expect(calls).toBe(1);

    scoped(appScope, () => {
      count.value = 2;
    });
    expect(calls).toBe(1);

    scoped(appScope, () => {
      expect(doubled.value).toBe(4);
    });
    expect(calls).toBe(2);
  });

  it("never invalidates when it has no dependencies", () => {
    const sc = scope();
    const unrelated = store(0);
    let calls = 0;
    const c = computed(() => {
      calls += 1;
      return 42;
    });

    scoped(sc, () => {
      expect(c.value).toBe(42);
      unrelated.value = 99;
      expect(c.value).toBe(42);
    });
    expect(calls).toBe(1);
  });

  describe("with nothing observing it", () => {
    it("halts propagation but recomputes once when next read", async () => {
      const sc = scope();
      const s = store(0);
      let computes = 0;
      const doubled = computed(() => {
        computes += 1;
        return s.value * 2;
      });

      // No read, no subscriber, no reaction -> unobserved.
      await run({ unit: s.node, payload: 1, scope: sc });
      expect(computes).toBe(0); // never eagerly computed

      expect(scoped(sc, () => doubled.value)).toBe(2);
      expect(computes).toBe(1); // recomputes exactly once on read
    });

    it("keeps a mapped store from computing", () => {
      const appScope = scope();
      const count = store(1);
      let calls = 0;
      const doubled = count.map((value) => {
        calls += 1;
        return value * 2;
      });
      const values: number[] = [];

      scoped(appScope, () => {
        count.value = 2;
      });
      expect(calls).toBe(0);

      scoped(appScope, () => {
        expect(doubled.value).toBe(4);
      });
      expect(calls).toBe(1);

      reaction({
        on: doubled,
        run(value: number) {
          values.push(value);
        },
      });

      scoped(appScope, () => {
        count.value = 3;
      });

      expect(calls).toBe(2);
      expect(values).toEqual([6]);
    });
  });

  it("resumes propagation once a reaction observes it", async () => {
    const sc = scope();
    const s = store(0);
    let computes = 0;
    const doubled = computed(() => {
      computes += 1;
      return s.value * 2;
    });
    const seen: number[] = [];

    // The computed reads `s` dynamically, so the per-scope edge only exists
    // after an in-scope read; establish it, then observe.
    expect(scoped(sc, () => doubled.value)).toBe(0);
    reaction({ scope: sc, on: doubled, run: (value: number) => seen.push(value) });

    await run({ unit: s.node, payload: 3, scope: sc });
    await flush();

    expect(seen).toEqual([6]);
    // Exactly one initial read + one recompute driven by the observing reaction.
    expect(computes).toBe(2);
  });
});
