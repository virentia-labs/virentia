import { describe, expect, it } from "vitest";
import { reaction, scope, scoped, store } from "../../lib";

// Deterministic PRNG so a failure is reproducible from its seed alone.
function rng(seed: number): () => number {
  let s = seed >>> 0;

  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;

    return s / 0x100000000;
  };
}

interface Step {
  write: number;
  readDerivedInSibling: boolean;
  readDerivedOutside: boolean;
  extraWriteSameValue: boolean;
}

// Invariant under test: once a derived unit has been materialized in a scope, its
// reaction fires exactly for the updates where its value actually changes —
// regardless of who reads it, or when.
function trial(seed: number): { seed: number; expected: number[]; actual: number[] } {
  const next = rng(seed);
  const mod = 2 + Math.floor(next() * 4);
  const mapper = (v: number): number => v % mod;

  const steps: Step[] = Array.from({ length: 8 }, () => ({
    write: Math.floor(next() * 6),
    readDerivedInSibling: next() < 0.5,
    readDerivedOutside: next() < 0.5,
    extraWriteSameValue: next() < 0.3,
  }));

  const $source = store(0);
  const $derived = $source.map(mapper);
  const actual: number[] = [];
  let readInSibling = false;

  reaction({
    on: $source,
    run: () => {
      if (readInSibling) void $derived.value;
    },
  });
  reaction({ on: $derived, run: (v: number) => actual.push(v) });

  const s = scope();
  // Materialize once so the "first propagation in a scope" rule is out of play.
  scoped(s, () => void $derived.value);

  const expected: number[] = [];
  let shadowSource = 0;
  let shadowDerived = mapper(0);

  for (const step of steps) {
    readInSibling = step.readDerivedInSibling;

    scoped(s, () => {
      $source.value = step.write;
      if (step.extraWriteSameValue) $source.value = step.write;
    });

    if (step.write !== shadowSource) {
      shadowSource = step.write;
      const nextDerived = mapper(shadowSource);

      if (nextDerived !== shadowDerived) {
        shadowDerived = nextDerived;
        expected.push(nextDerived);
      }
    }

    if (step.readDerivedOutside) {
      const observed = scoped(s, () => $derived.value);

      if (observed !== shadowDerived) {
        throw new Error(`seed ${seed}: read ${observed}, shadow ${shadowDerived}`);
      }
    }
  }

  return { seed, expected, actual };
}

describe("R6 randomized derived-notification invariant", () => {
  it("holds across 300 seeds", () => {
    const failures: Array<{ seed: number; expected: number[]; actual: number[] }> = [];

    for (let seed = 1; seed <= 300; seed += 1) {
      const result = trial(seed);

      if (JSON.stringify(result.expected) !== JSON.stringify(result.actual)) {
        failures.push(result);
      }
    }

    expect(failures.slice(0, 3)).toEqual([]);
  });
});


function rng2(seed: number): () => number {
  let s = seed >>> 0;

  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;

    return s / 0x100000000;
  };
}

// Two scopes, a three-link derived chain, reads injected at random links from a
// sibling reaction. Oracle: per scope, per link, a reaction fires exactly when
// that link's value changes.
function chainTrial(seed: number): string | null {
  const next = rng2(seed);
  const m1 = 2 + Math.floor(next() * 3);
  const m2 = 1 + Math.floor(next() * 4);
  const f1 = (v: number): number => v % m1;
  const f2 = (v: number): number => v * m2;
  const f3 = (v: number): string => `#${v}`;

  const $source = store(0);
  const $l1 = $source.map(f1);
  const $l2 = $l1.map(f2);
  const $l3 = $l2.map(f3);

  const scopes = [scope(), scope()];
  const actual: Record<string, unknown[]> = { "0": [], "1": [] };
  let readLink = 0;

  reaction({
    on: $source,
    run: () => {
      if (readLink === 1) void $l1.value;
      if (readLink === 2) void $l2.value;
      if (readLink === 3) void $l3.value;
    },
  });
  reaction({ on: $l3, scope: scopes[0], run: (v: string) => actual["0"].push(v) });
  reaction({ on: $l3, scope: scopes[1], run: (v: string) => actual["1"].push(v) });

  // Materialize in both scopes so the first-propagation rule is out of play.
  for (const s of scopes) scoped(s, () => void $l3.value);

  const shadowSource = [0, 0];
  const shadowL3 = [f3(f2(f1(0))), f3(f2(f1(0)))];
  const expected: Record<string, unknown[]> = { "0": [], "1": [] };

  for (let step = 0; step < 10; step += 1) {
    const which = next() < 0.5 ? 0 : 1;
    const write = Math.floor(next() * 7);
    readLink = Math.floor(next() * 4);

    scoped(scopes[which]!, () => {
      $source.value = write;
    });

    if (write !== shadowSource[which]) {
      shadowSource[which] = write;
      const nextL3 = f3(f2(f1(write)));

      if (nextL3 !== shadowL3[which]) {
        shadowL3[which] = nextL3;
        expected[String(which)]!.push(nextL3);
      }
    }

    // A read in a scope must always agree with the shadow for that scope.
    for (const [index, s] of scopes.entries()) {
      const observed = scoped(s, () => $l3.value);

      if (observed !== shadowL3[index]) {
        return `seed ${seed} step ${step}: scope ${index} read ${observed}, expected ${shadowL3[index]}`;
      }
    }
  }

  for (const key of ["0", "1"]) {
    if (JSON.stringify(expected[key]) !== JSON.stringify(actual[key])) {
      return `seed ${seed}: scope ${key} notifications ${JSON.stringify(
        actual[key],
      )}, expected ${JSON.stringify(expected[key])}`;
    }
  }

  return null;
}

describe("R6b randomized chain + multi-scope invariant", () => {
  it("holds across 200 seeds", () => {
    const failures: string[] = [];

    for (let seed = 1; seed <= 200; seed += 1) {
      const failure = chainTrial(seed);

      if (failure) failures.push(failure);
    }

    expect(failures.slice(0, 3)).toEqual([]);
  });
});
