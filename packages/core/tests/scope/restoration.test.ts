import { afterEach, describe, expect, it } from "vitest";
import { effect, event, getCurrentScope, reaction, scope, scoped, store } from "../../lib";
import type { Scope } from "../../lib";
import { resetActiveScope } from "../support/scope-helpers";

const tick = () => Promise.resolve();

afterEach(resetActiveScope);

describe("scope restoration", () => {
  describe("across an awaited body", () => {
    it("stays installed while an async scoped is pending", async () => {
      const s = scope();

      const pending = scoped(s, async () => {
        await Promise.resolve();
      });

      // The scope is still ambient synchronously after the call, before we await.
      expect(getCurrentScope()).toBe(s);

      await pending;

      expect(getCurrentScope()).toBe(null);
    });

    it("survives the body's own await of an event", async () => {
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

    it("survives the body's own await of an effect", async () => {
      const s = scope();
      const st = store(0);
      const fx = effect(async () => {
        await Promise.resolve();
        return 1;
      });

      let scopeAfterAwait: Scope | null = "unset" as unknown as Scope | null;

      await scoped(s, async () => {
        await fx();
        scopeAfterAwait = getCurrentScope();
        st.value = 5;
      });

      // Doc: await someFx() leaves the caller's real scope in place.
      expect(scopeAfterAwait).toBe(s);
      expect(scoped(s, () => st.value)).toBe(5);
    });

    it("holds the same scope at every await boundary", async () => {
      const s = scope();
      const observed: (Scope | null)[] = [];

      await scoped(s, async () => {
        observed.push(getCurrentScope());
        await Promise.resolve();
        observed.push(getCurrentScope());
        await Promise.resolve();
        observed.push(getCurrentScope());
        await new Promise<void>((r) => setTimeout(r, 0));
        observed.push(getCurrentScope());
      });

      expect(observed).toEqual([s, s, s, s]);
      expect(getCurrentScope()).toBe(null);
    });

    it("restores a nested async scoped to the enclosing scope", async () => {
      const outer = scope();
      const inner = scope();

      const observed = await scoped(outer, async () => {
        await scoped(inner, async () => {
          await Promise.resolve();
        });
        return getCurrentScope();
      });

      expect(observed).toBe(outer);
      expect(getCurrentScope()).toBe(null);
    });

    it("restores the previous scope after async scoped work", async () => {
      const outer = scope();
      const inner = scope();
      const value = store(0);

      await scoped(outer, async () => {
        value.value = 1;

        await scoped(inner, async () => {
          await Promise.resolve();
          value.value = 2;
        });

        expect(value.value).toBe(1);
      });

      scoped(inner, () => {
        expect(value.value).toBe(2);
      });
      expect(() => value.value).toThrow("Scope is required");
    });

    it("keeps the scope across writes on both sides of an await", async () => {
      const appScope = scope();
      const count = store(0);

      await scoped(appScope, async () => {
        count.value += 1;

        await Promise.resolve();
        count.value += 1;
      });

      scoped(appScope, () => {
        expect(count.value).toBe(2);
      });
      expect(() => count.value).toThrow("Scope is required");
    });

    it("keeps the scope across a single post-await write", async () => {
      const appScope = scope();
      const count = store(0);

      await scoped(appScope, async () => {
        await Promise.resolve();
        count.value += 1;
      });

      scoped(appScope, () => {
        expect(count.value).toBe(1);
      });
      expect(() => count.value).toThrow("Scope is required");
    });

    it("keeps the scope across several sequential awaits", async () => {
      const appScope = scope();
      const count = store(0);

      await scoped(appScope, async () => {
        await Promise.resolve();
        count.value += 1;

        await Promise.resolve();
        count.value += 1;

        await Promise.resolve();
        count.value += 1;
      });

      scoped(appScope, () => {
        expect(count.value).toBe(3);
      });
      expect(() => count.value).toThrow("Scope is required");
    });
  });

  describe("when the body fails", () => {
    it("restores the previous scope after an async rejection", async () => {
      const before = getCurrentScope();

      await expect(
        scoped(scope(), async () => {
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");

      expect(getCurrentScope()).toBe(before);
    });

    it("restores after spawned work settles despite an async rejection", async () => {
      const s = scope();
      const st = store(0);
      const ev = event();

      reaction({
        on: ev,
        run: async (_payload, api) => {
          await Promise.resolve();
          scoped(api.scope, () => {
            st.value = 7;
          });
        },
      });

      await expect(
        scoped(s, async () => {
          ev();
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");

      // The spawned reaction ran to completion before the rejection surfaced.
      expect(scoped(s, () => st.value)).toBe(7);
      expect(getCurrentScope()).toBe(null);
    });

    it("restores the previous scope after a synchronous throw", () => {
      const before = getCurrentScope();
      const s = scope();

      expect(() =>
        scoped(s, () => {
          throw new Error("sync");
        }),
      ).toThrow("sync");

      expect(getCurrentScope()).toBe(before);
    });

    it("assigns no return value when the body throws synchronously", () => {
      const s = scope();
      const fx = effect(async () => {
        await Promise.resolve();
        return 1;
      });

      let thrown: unknown;
      let returned: unknown = "not-set";
      try {
        returned = scoped(s, () => {
          void fx().catch(() => {});
          throw new Error("sync");
        });
      } catch (error) {
        thrown = error;
      }

      // The value was never assigned because scoped threw synchronously.
      expect(returned).toBe("not-set");
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toBe("sync");
    });

    it("resolves the scoped promise even when an async reaction fails", async () => {
      const s = scope();
      const ev = event();
      let ran = false;

      reaction({
        on: ev,
        run: async () => {
          ran = true;
          await Promise.resolve();
          throw new Error("reaction fail");
        },
      });

      await expect(scoped(s, () => ev())).resolves.toBeUndefined();
      expect(ran).toBe(true);
    });

    it("resolves the body even when a fire-and-forget effect fails", async () => {
      const s = scope();
      const fx = effect(async () => {
        await Promise.resolve();
        throw new Error("effect fail");
      });
      const failures: unknown[] = [];

      reaction({ on: fx.failData, run: (error) => failures.push(error) });

      await expect(
        scoped(s, async () => {
          void fx().catch(() => {});
        }),
      ).resolves.toBeUndefined();

      // The effect really did fail while scoped resolved cleanly.
      expect(failures).toHaveLength(1);
    });

    it("resolves to the body's value despite a rejecting spawned effect", async () => {
      const s = scope();
      const fx = effect(async () => {
        await Promise.resolve();
        throw new Error("spawn-reject");
      });
      reaction({ on: fx.failData, run: () => {} });

      const result = await scoped(s, async () => {
        void fx().catch(() => {});
        return "ok";
      });

      expect(result).toBe("ok");
      expect(getCurrentScope()).toBe(null);
    });
  });

  describe("after a detached async reaction", () => {
    it("leaves no ambient scope once a fire-and-forget effect settles", async () => {
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

    it("resets the ambient to null once scoped() returns", async () => {
      const appScope = scope();
      const dep = store(0);
      const fx = effect<void, void>(async () => {
        await tick();
      });
      reaction({
        on: [dep],
        scope: appScope,
        async run() {
          await fx();
        },
      });

      expect(getCurrentScope()).toBe(null); // clean before

      await scoped(appScope, async () => {
        dep.value = 1; // fires the reaction detached, inside this scope
        await scoped(tick);
        await scoped(tick);
      });

      // Control is back at top level; the scoped() block has fully unwound. Its own
      // restore set ambient back to null — the detached reaction must not have
      // clobbered it.
      expect(getCurrentScope()).toBe(null);
    });

    it("throws on an unscoped unit call right after scoped() returns", async () => {
      const appScope = scope();
      const dep = store(0);
      const fx = effect<void, void>(async () => {
        await tick();
      });
      reaction({
        on: [dep],
        scope: appScope,
        async run() {
          await fx();
        },
      });

      // Unrelated scope-bound reaction: it must NOT fire from a bare, unscoped call.
      const ping = event<number>();
      let firedFromBareCall = false;
      reaction({
        on: [ping],
        scope: appScope,
        run() {
          firedFromBareCall = true;
        },
      });

      await scoped(appScope, async () => {
        dep.value = 1;
        await scoped(tick);
        await scoped(tick);
      });

      // No scope is active now. A bare `ping(1)` MUST throw "Scope is required" —
      // with the leak, ambient is still appScope, so it silently runs instead.
      expect(() => ping(1)).toThrow(/scope is required/i);
      // await tick();
      // await tick();
      expect(firedFromBareCall).toBe(false);
    });
  });
});
