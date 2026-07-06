import { describe, expect, it } from "vitest";
import { effect, event, getCurrentScope, reaction, scope, scoped, store } from "../lib";

describe("async-callable units restore the caller's scope", () => {
  it("keeps the scope after awaiting an event that triggers an async reaction", async () => {
    const s = scope();
    const someStore = store(1);
    const ev = event<void>("e");

    reaction({
      on: ev,
      async run() {
        await Promise.resolve();
      },
    });

    await scoped(s, async () => {
      expect(getCurrentScope()).toBe(s);
      await ev();
      // Previously this reset to null and the read below threw "Scope is required".
      expect(getCurrentScope()).toBe(s);
      expect(someStore.value).toBe(1);
    });
  });

  it("keeps the scope after awaiting an effect", async () => {
    const s = scope();
    const someStore = store(2);
    const fx = effect(async () => {
      await Promise.resolve();
      return 0;
    });

    await scoped(s, async () => {
      await fx();
      expect(getCurrentScope()).toBe(s);
      expect(someStore.value).toBe(2);
    });
  });

  it("still leaves no ambient scope after a fire-and-forget effect settles", async () => {
    // The scoped() frame returns synchronously, so nothing awaits the effect;
    // the ambient scope must be neutral once control returns to the event loop.
    const s = scope();
    const slowFx = effect(async () => {
      await Promise.resolve();
    });

    scoped(s, () => {
      void slowFx();
    });

    expect(getCurrentScope()).toBeNull();

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(getCurrentScope()).toBeNull();
  });
});
