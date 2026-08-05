import { describe, expect, it } from "vitest";
import { computed, event, reaction, scope, scoped } from "@virentia/core";
import { mutableStore } from "../../lib";

// The core fix for "a read partway through an update swallows the derived's own
// notification" must hold for mutableStore too: it writes through
// `writeTransactionStore`, the same staging point the update epoch hangs off.
describe("mutableStore read-during-tick", () => {
  it("notifies a derived when a sibling reads it mid-update", () => {
    const s = scope();
    const state = mutableStore({ token: "" });
    const $authorized = computed(() => Boolean(state.value.token));
    const $raw = computed(() => state.value.token);
    let hits = 0;

    reaction({ on: $raw, run: () => void $authorized.value });
    reaction({ on: $authorized, run: () => hits++ });

    scoped(s, () => {
      state.value.token = "t";
    });

    expect(hits).toBe(1);
  });

  it("notifies when the write happens inside a reaction body and is read back", () => {
    const s = scope();
    const go = event<string>();
    const state = mutableStore({ token: "" });
    const $authorized = computed(() => Boolean(state.value.token));
    let hits = 0;

    reaction({
      on: go,
      run: (value: string) => {
        state.value.token = value;
        void $authorized.value;
      },
    });
    reaction({ on: $authorized, run: () => hits++ });

    scoped(s, () => go("t"));

    expect(hits).toBe(1);
  });

  it("notifies a subscriber-read derived", () => {
    const s = scope();
    const state = mutableStore({ n: 0 });
    const $doubled = computed(() => state.value.n * 2);
    let hits = 0;

    state.subscribe(() => void $doubled.value);
    reaction({ on: $doubled, run: () => hits++ });

    scoped(s, () => {
      state.value.n = 5;
    });

    expect(hits).toBe(1);
  });

  it("still dedups when the derived value does not change", () => {
    const s = scope();
    const state = mutableStore({ n: 1 });
    const $parity = computed(() => state.value.n % 2);
    const seen: number[] = [];

    reaction({ on: $parity, run: (v: number) => seen.push(v) });

    scoped(s, () => void $parity.value);
    scoped(s, () => {
      state.value.n = 3;
    });
    scoped(s, () => {
      state.value.n = 5;
    });

    expect(seen).toEqual([]);
  });

  it("keeps nested-path derived consistent across scopes", () => {
    const a = scope();
    const b = scope();
    const state = mutableStore({ user: { name: "x" } });
    const $name = computed(() => state.value.user.name);

    scoped(a, () => {
      state.value.user.name = "a";
    });
    scoped(b, () => {
      state.value.user.name = "b";
    });

    expect([scoped(a, () => $name.value), scoped(b, () => $name.value)]).toEqual(["a", "b"]);
  });
});
