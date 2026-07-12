import { afterEach, describe, expect, it, vi } from "vitest";
import {
  allSettled as effectorAllSettled,
  createEvent,
  createStore,
  fork,
  sample,
} from "effector";
import { event, reaction, scope, scoped, store } from "@virentia/core";
import { effectorAssociations, fool } from "../../lib";
import { flush, makeAssociation, resetAmbientScope } from "../support/effector-harness";

afterEach(resetAmbientScope);

describe("event bridging", () => {
  it("delivers an effector event targeting a fooled virentia event into the virentia scope", async () => {
    const effectorSubmitted = createEvent<number>();
    const virentiaSubmitted = fool(event<number>());
    const total = store(0);
    const { v, e } = makeAssociation();
    reaction({
      on: virentiaSubmitted,
      run(value) {
        total.value += value;
      },
    });
    sample({ clock: effectorSubmitted, target: virentiaSubmitted as any });
    await effectorAllSettled(effectorSubmitted, { scope: e, params: 4 });
    scoped(v, () => expect(total.value).toBe(4));
  });

  it("propagates a fooled virentia event fired in scope into the effector graph", async () => {
    const clock = fool(event<number>());
    const $sum = createStore(0).on(clock as any, (s, v) => s + (v as number));
    const { v, e } = makeAssociation();
    await scoped(v, () => (clock as unknown as (n: number) => unknown)(6));
    expect(e.getState($sum)).toBe(6);
  });

  it("bridges a fooled effector store's current scope state as the sampled payload", async () => {
    const $s = fool(createStore(10));
    const clk = fool(createEvent());
    const target = fool(createEvent<number>());
    const captured: number[] = [];
    reaction({ on: target as any, run: (x) => captured.push(x as number) });
    const { e } = makeAssociation();
    sample({ clock: clk, source: $s, target } as any);
    await effectorAllSettled(clk as any, { scope: e, params: undefined });
    expect(captured).toEqual([10]);
  });

  it("fires a bidirectional bridged event exactly once when triggered from the effector side", async () => {
    const f = fool(createEvent<number>());
    const $count = createStore(0).on(f as any, (c) => c + 1);
    let reactions = 0;
    reaction({ on: f as any, run: () => { reactions++; } });
    const { e } = makeAssociation();
    await effectorAllSettled(f as any, { scope: e, params: 5 });
    expect(e.getState($count)).toBe(1);
    expect(reactions).toBe(1);
  });

  it("settles a bidirectional bridged event once when triggered from the virentia side", async () => {
    const f = fool(createEvent<number>());
    const $count = createStore(0).on(f as any, (c) => c + 1);
    let reactions = 0;
    reaction({ on: f as any, run: () => { reactions++; } });
    const { v, e } = makeAssociation();
    await scoped(v, () => (f as unknown as (n: number) => unknown)(3));
    expect(e.getState($count)).toBe(1);
    expect(reactions).toBe(1);
  });

  it("never delivers an effector unit fired under an unrelated active virentia scope to it", async () => {
    const fA = fool(createEvent<number>());
    const seenA: number[] = [];
    reaction({ on: fA as any, run: (x) => seenA.push(x as number) });
    const { e: eA } = makeAssociation();
    const { v: vB } = makeAssociation();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await scoped(vB, () => effectorAllSettled(fA as any, { scope: eA, params: 1 }));
      await flush();
    } finally {
      consoleError.mockRestore();
    }
    // The cross-scope guard fired (surfaced on effector's error channel), and nothing
    // was delivered into vB's reaction — the payload is not misrouted to the wrong scope.
    // (The exact error channel is effector-internal; the contract we assert is non-delivery.
    // The guard's throw itself is verified directly in R-RES-2.)
    expect(seenA).toEqual([]);
  });
});

describe("composed event bridging", () => {
  it("uses fooled virentia units as effector sample clock, source, and target", async () => {
    const sessionChanged = fool(event<{ token: string }>());
    const userSelected = fool(event<string>());
    const userOpened = fool(event<{ userId: string; token: string }>());
    const opened: Array<{ userId: string; token: string }> = [];
    const { v } = makeAssociation();
    sample({
      clock: userSelected,
      source: sessionChanged,
      fn: (session: { token: string }, userId: string) => ({ userId, token: session.token }),
      target: userOpened,
    } as any);
    reaction({ on: userOpened, run: (value) => opened.push(value) });
    await scoped(v, async () => {
      await (sessionChanged as unknown as (s: { token: string }) => Promise<void>)({
        token: "tok",
      });
      await (userSelected as unknown as (s: string) => Promise<void>)("user:1");
    });
    expect(opened).toEqual([{ userId: "user:1", token: "tok" }]);
  });

  it("keeps two independent associations isolated for the same shared fooled unit", async () => {
    const submitted = fool(createEvent<number>());
    const total = store(0);
    reaction({
      on: submitted,
      run(value) {
        total.value += value as number;
      },
    });
    const { v: v1, e: e1 } = makeAssociation();
    const { v: v2, e: e2 } = makeAssociation();
    await effectorAllSettled(submitted as any, { scope: e1, params: 2 });
    await flush();
    await effectorAllSettled(submitted as any, { scope: e2, params: 5 });
    await flush();
    scoped(v1, () => expect(total.value).toBe(2));
    scoped(v2, () => expect(total.value).toBe(5));
  });

  it("does not retain a dropped, never-registered scope in the association WeakMaps", () => {
    // Indirect WeakMap-semantics check: an unregistered scope resolves to undefined.
    const stray = scope();
    expect(effectorAssociations.byVirentia.get(stray)).toBeUndefined();
    expect(effectorAssociations.byEffector.get(fork())).toBeUndefined();
  });
});
