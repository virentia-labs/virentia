import { describe, expect, it } from "vitest";
import { computed, effect, reaction, scope, scoped, store } from "../../lib";
import { flush } from "../support/async-flush";

describe("read-during-tick matrix", () => {
  it("reader is a sibling reaction (the reported repro)", () => {
    const $source = store<unknown>(null);
    const $derived = $source.map(Boolean);
    let hits = 0;
    reaction({ on: $source, run: () => void $derived.value });
    reaction({ on: $derived, run: () => hits++ });
    scoped(scope(), () => {
      $source.value = "x";
    });
    expect(hits).toBe(1);
  });

  it("reader is a subscribe() callback on the source", () => {
    const $source = store<unknown>(null);
    const $derived = $source.map(Boolean);
    let hits = 0;
    $source.subscribe(() => void $derived.value);
    reaction({ on: $derived, run: () => hits++ });
    scoped(scope(), () => {
      $source.value = "x";
    });
    expect(hits).toBe(1);
  });

  it("computed never read in the scope, first read mid-tick", () => {
    const $source = store<unknown>(null);
    const $derived = computed(() => Boolean($source.value));
    let hits = 0;
    reaction({ on: $source, run: () => void $derived.value });
    reaction({ on: $derived, run: () => hits++ });
    scoped(scope(), () => {
      $source.value = "x";
    });
    expect(hits).toBe(1);
  });

  it("reader is an effect handler", async () => {
    const $source = store<unknown>(null);
    const $derived = $source.map(Boolean);
    let hits = 0;
    const readFx = effect(() => void $derived.value);
    reaction({ on: $source, run: () => void readFx() });
    reaction({ on: $derived, run: () => hits++ });
    await scoped(scope(), () => {
      $source.value = "x";
    });
    await flush();
    expect(hits).toBe(1);
  });

  it("chain: reader reads the middle link", () => {
    const $source = store(0);
    const $mid = $source.map((v) => v + 1);
    const $leaf = $mid.map((v) => v * 10);
    let midHits = 0;
    let leafHits = 0;
    reaction({ on: $source, run: () => void $mid.value });
    reaction({ on: $mid, run: () => midHits++ });
    reaction({ on: $leaf, run: () => leafHits++ });
    scoped(scope(), () => {
      $source.value = 5;
    });
    expect({ midHits, leafHits }).toEqual({ midHits: 1, leafHits: 1 });
  });

  it("two writes in one body with a read between them", () => {
    const $source = store(0);
    const $derived = $source.map((v) => v * 2);
    const seen: number[] = [];
    reaction({ on: $source, run: () => void $derived.value });
    reaction({ on: $derived, run: (v: number) => seen.push(v) });
    scoped(scope(), () => {
      $source.value = 1;
      $source.value = 2;
    });
    expect(seen).toEqual([2, 4]);
  });

  // Guards against over-firing: dedup must survive the fix.
  it("still does NOT notify when the mapped value is unchanged", () => {
    const $source = store(1);
    const $parity = $source.map((v) => v % 2);
    const seen: number[] = [];
    const s = scope();
    reaction({ on: $parity, run: (v: number) => seen.push(v) });
    scoped(s, () => {
      $source.value = 3;
      $source.value = 5;
      $source.value = 2;
    });
    expect(seen).toEqual([1, 0]);
  });

  it("still dedups when the value is read beforehand and does not change", () => {
    const $source = store(1);
    const $parity = $source.map((v) => v % 2);
    const seen: number[] = [];
    const s = scope();
    reaction({ on: $parity, run: (v: number) => seen.push(v) });
    scoped(s, () => {
      void $parity.value;
      $source.value = 3;
      $source.value = 7;
    });
    expect(seen).toEqual([]);
  });

  it("still dedups with a sibling reader when nothing actually changes", () => {
    const $source = store(1);
    const $parity = $source.map((v) => v % 2);
    const seen: number[] = [];
    const s = scope();
    reaction({ on: $source, run: () => void $parity.value });
    reaction({ on: $parity, run: (v: number) => seen.push(v) });
    scoped(s, () => {
      void $parity.value;
      $source.value = 3;
      $source.value = 7;
    });
    expect(seen).toEqual([]);
  });
});
