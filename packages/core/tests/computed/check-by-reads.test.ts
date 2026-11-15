import { describe, expect, it } from "vitest";
import { computed, scope, scoped, store } from "../../lib";

// A computed marked for a check brings up to date only the computeds it read
// when it was last evaluated in that scope, and recomputes only if one of them
// changed since. An observed computed keeps global edges to every branch it has
// read anywhere; a branch it does not read now is not evaluated for it.
describe("checking a computed by what it last read", () => {
  it("leaves a branch it does not read now alone", () => {
    const useLeft = store(true);
    const left = store(1),
      right = store(2);
    const calls = { left: 0, right: 0, picked: 0 };
    const leftTwice = computed(() => {
      calls.left++;
      return left.value * 2;
    });
    const rightTwice = computed(() => {
      calls.right++;
      return right.value * 2;
    });
    const picked = computed(() => {
      calls.picked++;
      return useLeft.value ? leftTwice.value : rightTwice.value;
    });
    const app = scope();
    const seen: number[] = [];
    // Observed: its first evaluation (left) makes global edges; then it reads
    // the right branch in the scope, which adds those edges too.
    const off = picked.subscribe((value) => seen.push(value));
    scoped(app, () => {
      useLeft.value = false;
    });
    expect(seen).toEqual([4]);
    const before = { ...calls };
    scoped(app, () => {
      left.value = 10;
    });
    expect(seen).toEqual([4]);
    expect(calls.picked - before.picked).toBe(0);
    expect(calls.left - before.left).toBe(0);
    expect(scoped(app, () => picked.value)).toBe(4);
    scoped(app, () => {
      useLeft.value = true;
    });
    expect(seen).toEqual([4, 20]);
    off();
  });

  it("recomputes when a computed it read changed since", () => {
    const source = store(1);
    const doubled = computed(() => source.value * 2);
    const plusOne = computed(() => doubled.value + 1);
    const app = scope();
    const seen: number[] = [];
    const off = plusOne.subscribe((value) => seen.push(value));
    for (let value = 2; value <= 4; value++)
      scoped(app, () => {
        source.value = value;
      });
    expect(seen).toEqual([5, 7, 9]);
    off();
  });

  it("follows a reader into a scope it has not read in yet", () => {
    const source = store(1);
    const doubled = computed(() => source.value * 2);
    const plusOne = computed(() => doubled.value + 1);
    const left = scope(),
      right = scope();
    const seen: [string, number][] = [];
    const off = plusOne.subscribe((value, at) => seen.push([at === left ? "left" : "right", value]));
    scoped(left, () => {
      source.value = 2;
    });
    scoped(right, () => {
      source.value = 3;
    });
    scoped(left, () => {
      source.value = 4;
    });
    expect(seen).toEqual([
      ["left", 5],
      ["right", 7],
      ["left", 9],
    ]);
    off();
  });

  it("makes global edges for what it read before it was observed", () => {
    // Read in a scope while unobserved, then observed: its next evaluation
    // there reads the same, and must still turn those reads into global edges
    // so that a write in a scope it never read in reaches it.
    const useA = store(true);
    const a = store(1),
      b = store(2);
    const picked = computed(() => (useA.value ? a.value : b.value));
    const first = scope(),
      other = scope();
    scoped(first, () => {
      useA.value = false;
    });
    scoped(other, () => {
      useA.value = false;
    });
    expect(scoped(first, () => picked.value)).toBe(2);
    const seen: [string, number][] = [];
    const off = picked.subscribe((value, at) => seen.push([at === first ? "first" : "other", value]));
    scoped(first, () => {
      b.value = 3;
    });
    scoped(other, () => {
      b.value = 5;
    });
    expect(seen).toEqual([
      ["first", 3],
      ["other", 5],
    ]);
    off();
  });
});
