import { describe, expect, it } from "vitest";
import { allSettled, computed, event, reaction, scope, scoped } from "@virentia/core";
import { mutableStore, seedMutableStore, unwrap } from "../lib";

describe("mutableStore", () => {
  it("mutates deeply and reacts", () => {
    const s = scope();
    const state = mutableStore({ user: { name: "a", tags: ["x"] }, count: 0 });
    const count = computed(() => state.value.count);

    scoped(s, () => {
      expect(count.value).toBe(0);

      state.value.user.name = "b";
      state.value.user.tags.push("y");
      state.value.count += 1;

      expect(state.value.user).toEqual({ name: "b", tags: ["x", "y"] });
      expect(count.value).toBe(1);
    });
  });

  it("copy-on-writes only touched branches and never touches the default", () => {
    const initial = { a: { v: 1 }, b: { v: 2 } };
    const state = mutableStore(initial);
    const s = scope();

    scoped(s, () => {
      state.value.a.v = 10;
    });

    // The default object is untouched (no structuredClone, no in-place on the base).
    expect(initial).toEqual({ a: { v: 1 }, b: { v: 2 } });

    scoped(s, () => {
      expect(state.value.a.v).toBe(10);
      // `a` was copied; `b` is shared with the default by reference.
      expect(unwrap(state.value.a)).not.toBe(initial.a);
      expect(unwrap(state.value.b)).toBe(initial.b);
    });
  });

  it("isolates scopes and shares the untouched default across them", () => {
    const initial = { a: { v: 1 }, b: { v: 2 } };
    const state = mutableStore(initial);
    const x = scope();
    const y = scope();

    scoped(x, () => (state.value.a.v = 10));

    // `y` never diverged — it still sees the default, `a` unchanged.
    expect(scoped(y, () => state.value.a.v)).toBe(1);
    // Both scopes still share the untouched `b` with the default.
    expect(scoped(x, () => unwrap(state.value.b))).toBe(initial.b);
    expect(scoped(y, () => unwrap(state.value.b))).toBe(initial.b);
  });

  it("mutates a branch the scope already owns in place (stable identity)", () => {
    const state = mutableStore({ list: [] as number[] });
    const s = scope();

    scoped(s, () => state.value.list.push(1));
    const firstRef = scoped(s, () => unwrap(state.value.list));

    scoped(s, () => state.value.list.push(3));
    const secondRef = scoped(s, () => unwrap(state.value.list));

    expect([...secondRef]).toEqual([1, 3]);
    expect(secondRef).toBe(firstRef); // owned → mutated in place
  });

  it("does not mutate an object assigned into the tree", () => {
    const external = { k: 1 };
    const state = mutableStore({ ref: null as null | { k: number } });
    const s = scope();

    scoped(s, () => (state.value.ref = external));
    scoped(s, () => (state.value.ref!.k = 2)); // copy-on-write, external untouched

    expect(external.k).toBe(1);
    expect(scoped(s, () => state.value.ref!.k)).toBe(2);
  });

  it("supports native array mutators", () => {
    const s = scope();
    const state = mutableStore({ items: [1, 2, 3] });

    scoped(s, () => {
      state.value.items.splice(1, 1);
      state.value.items.unshift(0);
      state.value.items.push(9);
      expect([...state.value.items]).toEqual([0, 1, 3, 9]);
    });
  });

  it("notifies subscribers and drives a map, batched inside a reaction", async () => {
    const s = scope();
    const bumped = event<void>();
    const state = mutableStore({ n: 0, other: 5 });
    const doubled = state.map((value) => value.n * 2);
    const seen: number[] = [];

    state.subscribe((value) => seen.push(value.n));

    reaction({
      on: bumped,
      run() {
        state.value.n += 1;
        state.value.other += 1;
      },
    });

    await allSettled(bumped, { scope: s, payload: undefined });
    await allSettled(bumped, { scope: s, payload: undefined });

    expect(scoped(s, () => doubled.value)).toBe(4);
    expect(seen).toEqual([1, 2]); // one notification per transaction (batched)
  });

  it("treats Date as a leaf — replace it, don't mutate into it", () => {
    const s = scope();
    const state = mutableStore({ when: new Date(0) });

    scoped(s, () => {
      state.value.when = new Date(1000);
      expect(state.value.when.getTime()).toBe(1000);
    });
  });

  it("can be seeded per scope", () => {
    const s = scope();
    const state = mutableStore({ count: 0 });

    seedMutableStore(s, state, { count: 42 });

    expect(scoped(s, () => state.value.count)).toBe(42);
  });

  it("replaces the whole value through the setter", () => {
    const s = scope();
    const state = mutableStore({ a: 1 });

    scoped(s, () => {
      state.value = { a: 99 };
      expect(state.value.a).toBe(99);
    });
  });

  it("subscribes computeds per keypath — a sibling change does not re-run them", async () => {
    const s = scope();
    const changeItems = event<void>();
    const changeCoupon = event<void>();
    const cart = mutableStore({ items: [] as number[], coupon: "" });

    const count = computed(() => cart.value.items.length);
    const coupon = computed(() => cart.value.coupon);

    let countRuns = 0;
    let couponRuns = 0;
    reaction({ on: count, run: () => void countRuns++ });
    reaction({ on: coupon, run: () => void couponRuns++ });

    reaction({ on: changeItems, run: () => void cart.value.items.push(1) });
    reaction({ on: changeCoupon, run: () => void (cart.value.coupon = "SALE") });

    // First read registers each computed's keypath dependencies.
    scoped(s, () => {
      void count.value;
      void coupon.value;
    });
    countRuns = 0;
    couponRuns = 0;

    await allSettled(changeItems, { scope: s, payload: undefined });
    expect(countRuns).toBe(1);
    expect(couponRuns).toBe(0); // `coupon` never read `items` → not re-run

    await allSettled(changeCoupon, { scope: s, payload: undefined });
    expect(couponRuns).toBe(1);
    expect(countRuns).toBe(1); // `count` never read `coupon` → still 1
  });

  it("keeps deep siblings independent", async () => {
    const s = scope();
    const editA = event<void>();
    const doc = mutableStore({ a: { x: 0 }, b: { y: 0 } });

    const av = computed(() => doc.value.a.x);
    const bv = computed(() => doc.value.b.y);
    let aRuns = 0;
    let bRuns = 0;
    reaction({ on: av, run: () => void aRuns++ });
    reaction({ on: bv, run: () => void bRuns++ });
    reaction({ on: editA, run: () => void (doc.value.a.x = 1) });

    scoped(s, () => {
      void av.value;
      void bv.value;
    });
    aRuns = 0;
    bRuns = 0;

    await allSettled(editA, { scope: s, payload: undefined });
    expect(aRuns).toBe(1);
    expect(bRuns).toBe(0); // editing `a.x` leaves `b.y` readers alone
  });

  it("makes map granular — unrelated changes do not notify it", async () => {
    const s = scope();
    const changeItems = event<void>();
    const cart = mutableStore({ items: [] as number[], coupon: "" });

    const coupon = cart.map((value) => value.coupon);
    let runs = 0;
    reaction({ on: coupon, run: () => void runs++ });
    reaction({ on: changeItems, run: () => void cart.value.items.push(1) });

    scoped(s, () => void coupon.value);
    runs = 0;

    await allSettled(changeItems, { scope: s, payload: undefined });
    expect(runs).toBe(0); // the map read only `coupon`
  });

  it("unwrap takes a coarse dependency — re-runs on any change", async () => {
    const s = scope();
    const bump = event<void>();
    const state = mutableStore({ a: 0, b: 0 });

    const whole = computed(() => {
      const v = unwrap(state.value);
      return v.a + v.b;
    });
    let runs = 0;
    reaction({ on: whole, run: () => void runs++ });
    reaction({ on: bump, run: () => void (state.value.b += 1) });

    scoped(s, () => void whole.value);
    runs = 0;

    await allSettled(bump, { scope: s, payload: undefined });
    expect(runs).toBe(1); // unwrap reads the whole value, so any change re-runs it
  });

  it("defers a replace + mutation to a single atomic commit inside a reaction", async () => {
    const s = scope();
    const go = event<void>();
    const state = mutableStore({ a: 0, b: 0 });
    const seen: Array<{ a: number; b: number }> = [];

    state.subscribe((value) => seen.push({ ...value }));

    reaction({
      on: go,
      run() {
        state.value = { a: 1, b: 1 }; // wholesale replace
        state.value.a = 2; // then mutate the replacement
      },
    });

    await allSettled(go, { scope: s, payload: undefined });

    // One notification with the combined result — nothing was committed early.
    expect(seen).toEqual([{ a: 2, b: 1 }]);
    expect(scoped(s, () => ({ a: state.value.a, b: state.value.b }))).toEqual({ a: 2, b: 1 });
  });
});
