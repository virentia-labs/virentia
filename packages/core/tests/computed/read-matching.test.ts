import { describe, expect, it } from "vitest";
import { computed, reaction, scope, scoped, store, type StoreWritable } from "../../lib";

// A computed with many reads matches them against its previous reads in order
// and keeps its edges when they are the same. Every way the reads can change
// must still reach the edges.
const many = (count: number, from = 0): StoreWritable<number>[] =>
  Array.from({ length: count }, (_, index) => store(from + index));
const sum = (sources: readonly StoreWritable<number>[]): number =>
  sources.reduce((total, source) => total + source.value, 0);

describe("a fan-in computed matching its reads", () => {
  it("keeps following the same sources across re-evaluations", () => {
    const sources = many(20);
    const total = computed(() => sum(sources));
    const app = scope();
    const seen: number[] = [];
    scoped(app, () => reaction({ on: total, run: (value) => seen.push(value) }));
    for (let round = 1; round <= 3; round++)
      scoped(app, () => {
        sources[round].value += 100;
        sources[19].value += 1;
      });
    expect(seen).toEqual([290, 291, 391, 392, 492, 493]);
  });

  it("follows a branch that reads other sources and drops the old ones", () => {
    const left = many(20, 0),
      right = many(20, 1000);
    const useLeft = store(true);
    const total = computed(() => (useLeft.value ? sum(left) : sum(right)));
    const app = scope();
    const seen: number[] = [];
    scoped(app, () => reaction({ on: total, run: (value) => seen.push(value) }));
    scoped(app, () => {
      left[0].value = 1;
    });
    scoped(app, () => {
      useLeft.value = false;
    });
    scoped(app, () => {
      left[1].value = 50;
    });
    scoped(app, () => {
      right[19].value += 1;
    });
    expect(seen).toEqual([191, 20190, 20191]);
  });

  it("drops the sources a shorter evaluation no longer reads", () => {
    const sources = many(20);
    const count = store(20);
    const total = computed(() => sum(sources.slice(0, count.value)));
    const app = scope();
    const seen: number[] = [];
    scoped(app, () => reaction({ on: total, run: (value) => seen.push(value) }));
    scoped(app, () => {
      count.value = 17;
    });
    scoped(app, () => {
      sources[18].value = 1000;
    });
    scoped(app, () => {
      sources[16].value += 1;
    });
    expect(seen).toEqual([136, 137]);
  });

  it("matches reads that repeat a source", () => {
    const sources = many(18);
    const total = computed(() => sum(sources) + sources[0].value + sources[5].value);
    const app = scope();
    const seen: number[] = [];
    scoped(app, () => reaction({ on: total, run: (value) => seen.push(value) }));
    scoped(app, () => {
      sources[5].value += 10;
    });
    scoped(app, () => {
      sources[17].value += 1;
    });
    expect(seen).toEqual([178, 179]);
  });

  it("keeps the edges of each scope", () => {
    const sources = many(20);
    const total = computed(() => sum(sources));
    const first = scope(),
      second = scope();
    const seen: string[] = [];
    // Read in both scopes, so each has its own state and edges.
    expect([scoped(first, () => total.value), scoped(second, () => total.value)]).toEqual([190, 190]);
    const stop = total.subscribe((value, at) => seen.push(`${at === first ? "first" : "second"} ${value}`));
    scoped(first, () => {
      sources[0].value = 10;
    });
    scoped(second, () => {
      sources[1].value = 20;
    });
    scoped(first, () => {
      sources[2].value = 30;
    });
    expect(seen).toEqual(["first 200", "second 209", "first 228"]);
    stop();
  });

  it("keeps the scoped edges of each scope while unobserved", () => {
    const sources = many(20);
    const total = computed(() => sum(sources));
    const first = scope(),
      second = scope();
    const seen: string[] = [];
    expect([scoped(first, () => total.value), scoped(second, () => total.value)]).toEqual([190, 190]);
    reaction({ scope: first, on: total, run: (value) => seen.push(`first ${value}`) });
    reaction({ scope: second, on: total, run: (value) => seen.push(`second ${value}`) });
    for (let round = 0; round < 2; round++) {
      scoped(first, () => {
        sources[round].value += 10;
      });
      scoped(second, () => {
        sources[19 - round].value += 1;
      });
    }
    expect(seen).toEqual(["first 200", "second 191", "first 210", "second 192"]);
  });

  it("follows its sources in every scope once it becomes observed", () => {
    const sources = many(20);
    const total = computed(() => sum(sources));
    const app = scope(),
      other = scope();
    // Read unobserved first: the reads are recorded for this scope.
    expect(scoped(app, () => total.value)).toBe(190);
    const seen: number[] = [];
    const stop = total.subscribe((value) => seen.push(value));
    scoped(app, () => {
      sources[0].value = 5;
    });
    scoped(other, () => {
      sources[1].value = 7;
    });
    expect(seen).toEqual([195, 196]);
    stop();
  });
});
