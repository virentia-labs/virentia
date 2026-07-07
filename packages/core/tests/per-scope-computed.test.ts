import { describe, expect, it } from "vitest";
import { computed, scope, scoped, store } from "../lib";
import { run } from "../lib/internal";

describe("per-scope computed", () => {
  it("invalidates a data-dependent computed precisely per scope", async () => {
    const a = scope();
    const b = scope();
    const useLeft = store(true);
    const left = store(1);
    const right = store(100);
    let computes = 0;
    const picked = computed(() => {
      computes += 1;
      return useLeft.value ? left.value : right.value;
    });

    // In scope `b` the computed reads `right`; in scope `a` it reads `left`.
    await run({ unit: useLeft.node, payload: false, scope: b });

    expect(scoped(a, () => picked.value)).toBe(1);
    expect(scoped(b, () => picked.value)).toBe(100);

    const baseline = computes;

    // `left` changes in `b`, whose branch reads `right` — must NOT invalidate
    // the computed there (a global dependency union would over-invalidate).
    await run({ unit: left.node, payload: 2, scope: b });
    expect(scoped(b, () => picked.value)).toBe(100);
    expect(computes).toBe(baseline);

    // `left` changes in `a`, whose branch reads `left` — must invalidate there.
    await run({ unit: left.node, payload: 3, scope: a });
    expect(scoped(a, () => picked.value)).toBe(3);
    expect(computes).toBe(baseline + 1);
  });

  it("keeps computed values independent across scopes", async () => {
    const a = scope();
    const b = scope();
    const base = store(1);
    const doubled = computed(() => base.value * 2);

    await run({ unit: base.node, payload: 5, scope: a });
    await run({ unit: base.node, payload: 9, scope: b });

    expect(scoped(a, () => doubled.value)).toBe(10);
    expect(scoped(b, () => doubled.value)).toBe(18);
  });
});
