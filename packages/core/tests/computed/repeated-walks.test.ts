import { describe, expect, it } from "vitest";
import { computed, reaction, scope, scoped, store } from "../../lib";

// An update in a root scope remembers which observers each node reached and
// replays that on the next update while the graph keeps its shape. Every way
// the graph or the scope can change between two updates must still be seen.
describe("repeated updates over one graph", () => {
  it("reach the same readers on every update", () => {
    const source = store(0);
    const calls = [0, 0, 0];
    const parts = calls.map((_, index) =>
      source.map((value) => {
        calls[index]++;
        return value + index;
      }),
    );
    const total = computed(() => parts.reduce((sum, part) => sum + part.value, 0));
    const app = scope();
    scoped(app, () => total.value);
    const seen: number[] = [];
    total.subscribe((value) => seen.push(value));
    for (let value = 1; value <= 4; value++)
      scoped(app, () => {
        source.value = value;
      });
    expect(seen).toEqual([6, 9, 12, 15]);
    // The read in the scope, the subscription's first evaluation, one per update.
    expect(calls).toEqual([6, 6, 6]);
  });

  it("stop at an observer removed between updates", () => {
    const source = store(0);
    const doubled = source.map((value) => value * 2);
    const app = scope();
    const seen: number[] = [];
    const stop = doubled.subscribe((value) => seen.push(value));
    for (let value = 1; value <= 3; value++)
      scoped(app, () => {
        source.value = value;
      });
    stop();
    scoped(app, () => {
      source.value = 10;
    });
    expect(seen).toEqual([2, 4, 6]);
    expect(scoped(app, () => doubled.value)).toBe(20);
  });

  it("reach an observer added between updates", () => {
    const source = store(0);
    const doubled = source.map((value) => value * 2);
    const app = scope();
    const first: number[] = [],
      second: number[] = [];
    doubled.subscribe((value) => first.push(value));
    for (let value = 1; value <= 2; value++)
      scoped(app, () => {
        source.value = value;
      });
    const tripled = source.map((value) => value * 3);
    tripled.subscribe((value) => second.push(value));
    for (let value = 3; value <= 4; value++)
      scoped(app, () => {
        source.value = value;
      });
    expect(first).toEqual([2, 4, 6, 8]);
    expect(second).toEqual([9, 12]);
  });

  it("follow a reaction that joins and leaves the graph", () => {
    const source = store(0);
    const doubled = source.map((value) => value * 2);
    const app = scope();
    const seen: number[] = [],
      reacted: number[] = [];
    doubled.subscribe((value) => seen.push(value));
    scoped(app, () => {
      source.value = 1;
    });
    const watcher = scoped(app, () =>
      reaction({ scope: app, on: doubled, run: (value) => reacted.push(value) }),
    );
    scoped(app, () => {
      source.value = 2;
    });
    watcher.stop();
    for (let value = 3; value <= 4; value++)
      scoped(app, () => {
        source.value = value;
      });
    expect(seen).toEqual([2, 4, 6, 8]);
    expect(reacted).toEqual([4]);
  });

  it("keep scopes apart when they take turns", () => {
    const source = store(0);
    const doubled = source.map((value) => value * 2);
    const left = scope(),
      right = scope();
    const seen: [string, number][] = [];
    doubled.subscribe((value, at) => seen.push([at === left ? "left" : "right", value]));
    for (let value = 1; value <= 2; value++) {
      scoped(left, () => {
        source.value = value;
      });
      scoped(right, () => {
        source.value = value * 10;
      });
    }
    expect(seen).toEqual([
      ["left", 2],
      ["right", 20],
      ["left", 4],
      ["right", 40],
    ]);
  });
});

describe("a computed read in a scope before it was observed", () => {
  it("is reached through the sources of that read", () => {
    // Observed, it follows what it reads globally; the branch it took in the
    // scope before that is known only from the edges that read left there.
    const useA = store(true);
    const a = store(1),
      b = store(2);
    const picked = computed(() => (useA.value ? a.value : b.value));
    const app = scope();
    scoped(app, () => {
      useA.value = false;
    });
    expect(scoped(app, () => picked.value)).toBe(2);
    const seen: number[] = [];
    picked.subscribe((value) => seen.push(value));
    const writes: [typeof a | typeof useA, number | boolean][] = [
      [b, 3],
      [b, 4],
      [useA, true],
      [b, 5],
      [a, 7],
      [useA, false],
      [b, 6],
    ];
    for (const [target, value] of writes)
      scoped(app, () => {
        (target as { value: unknown }).value = value;
      });
    expect(seen).toEqual([3, 4, 1, 7, 5, 6]);
  });
});
