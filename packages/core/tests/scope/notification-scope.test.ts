import { afterEach, describe, expect, it } from "vitest";
import { event, reaction, scope, scoped, store } from "../../lib";
import type { Scope } from "../../lib";
import { resetActiveScope } from "../support/scope-helpers";

afterEach(resetActiveScope);

// A store write inside an auto-reaction body happens with the run's micro-scope
// installed as the ambient scope. The committed value lands in the real scope
// (micro-scopes share the value map by reference), so the notification must
// carry the real scope too — a subscriber that filters by scope identity
// (useUnit does exactly that) would otherwise silently drop the update.
describe("subscriber notification scope", () => {
  it("notifies with the real firing scope regardless of how the write happened", async () => {
    const appScope = scope();

    const source = store(true);
    const toggled = event();
    reaction({
      on: toggled,
      run: () => {
        source.value = !source.value;
      },
    });

    // Three mirrors of `source`, differing only in HOW the write happens.
    const viaAuto = store(true);
    const viaScopedAuto = store(true);
    const viaExplicit = store(true);

    reaction(() => {
      viaAuto.value = source.value;
    });
    reaction({
      scope: appScope,
      run: () => {
        viaScopedAuto.value = source.value;
      },
    });
    reaction({
      on: toggled,
      run: () => {
        viaExplicit.value = !viaExplicit.value;
      },
    });

    const notified = new Map<string, Scope>();
    source.subscribe((_, s) => notified.set("source", s));
    viaAuto.subscribe((_, s) => notified.set("viaAuto", s));
    viaScopedAuto.subscribe((_, s) => notified.set("viaScopedAuto", s));
    viaExplicit.subscribe((_, s) => notified.set("viaExplicit", s));

    await scoped(appScope, () => toggled());

    // Every write committed into appScope...
    scoped(appScope, () => {
      expect(source.value).toBe(false);
      expect(viaAuto.value).toBe(false);
      expect(viaScopedAuto.value).toBe(false);
      expect(viaExplicit.value).toBe(false);
    });

    // ...so every subscriber must have been notified with appScope itself.
    expect(notified.get("source")).toBe(appScope);
    expect(notified.get("viaExplicit")).toBe(appScope);
    expect(notified.get("viaAuto")).toBe(appScope);
    expect(notified.get("viaScopedAuto")).toBe(appScope);
  });

  it("keeps a write readable within the same auto-reaction body", async () => {
    const appScope = scope();
    const trigger = store(0);
    const target = store(0);
    const observed: number[] = [];

    // The write is staged under the real scope while the body reads through its
    // micro-scope — the read-back must still see the pending value.
    reaction(() => {
      const next = trigger.value * 2;

      if (next !== 0) {
        target.value = next;
        observed.push(target.value);
      }
    });

    await scoped(appScope, () => {
      trigger.value = 21;
    });

    expect(observed[0]).toBe(42);
    scoped(appScope, () => {
      expect(target.value).toBe(42);
    });
  });
});
