import { afterEach, describe, expect, it } from "vitest";
import { event, getCurrentScope, reaction, scope, scoped, store } from "../../lib";
import type { Scope } from "../../lib";
import { node, requireActiveScope, run } from "../../lib/internal";
import { scopeRequiredError } from "../../lib/scope/internal";
import { withInspectorMeta } from "../../lib/kernel/inspector";
import { resetActiveScope } from "../support/scope-helpers";

afterEach(resetActiveScope);

describe("scoped()", () => {
  it("returns fn's value using the ambient scope", () => {
    const s = scope();

    expect(scoped(s, () => scoped(() => 42))).toBe(42);
  });

  it("returns the synchronous value of fn", () => {
    expect(scoped(scope(), () => "x")).toBe("x");
  });

  it("returns a runner bound to the ambient scope when called with no args", () => {
    const s = scope();

    const observed = scoped(s, () => {
      const runner = scoped();
      return runner(() => getCurrentScope());
    });

    expect(observed).toBe(s);
  });

  it("restores the previous scope immediately after a synchronous fn", () => {
    const before = getCurrentScope();
    scoped(scope(), () => {});
    expect(getCurrentScope()).toBe(before);

    const outer = scope();
    scoped(outer, () => {
      const nestedBefore = getCurrentScope();
      expect(nestedBefore).toBe(outer);
      scoped(scope(), () => {});
      expect(getCurrentScope()).toBe(outer);
    });
  });

  it("resolves an async body to fn's resolved value", async () => {
    const result = await scoped(scope(), async () => {
      await Promise.resolve();
      return 99;
    });

    expect(result).toBe(99);
  });

  it("routes a custom thenable through the settle path", async () => {
    const before = getCurrentScope();
    const thenable = {
      then(resolve: (value: string) => void) {
        resolve("t");
      },
    };

    const result = await scoped(scope(), () => thenable);

    expect(result).toBe("t");
    expect(getCurrentScope()).toBe(before);
  });

  it("installs the scope only for the duration of the frame", () => {
    expect(getCurrentScope()).toBe(null);
    const s = scope();
    scoped(s, () => {
      expect(getCurrentScope()).toBe(s);
    });
    expect(getCurrentScope()).toBe(null);
  });

  it("writes through the ambient scope when given no explicit scope", () => {
    const appScope = scope();
    const count = store(0);

    scoped(appScope, () => {
      scoped(() => {
        count.value += 1;
      });
    });

    scoped(appScope, () => {
      expect(count.value).toBe(1);
    });
  });

  it("uses the current scope for a unit triggered from nested scoped work", async () => {
    const appScope = scope();
    const submitted = event<number>();
    const value = store(0);

    reaction({
      on: submitted,
      run: (next: number) => {
        value.value = next;
      },
    });

    const publish = (next: number) => scoped(() => submitted(next));

    await scoped(appScope, () => publish(5));

    scoped(appScope, () => {
      expect(value.value).toBe(5);
    });
  });

  describe("with no active scope", () => {
    it("throws when called with no arguments", () => {
      expect(getCurrentScope()).toBe(null);
      expect(() => scoped()).toThrow("Scope is required to use scoped()");
    });

    it("throws when called with only a fn", () => {
      expect(() => scoped(() => 1)).toThrow("Scope is required to use scoped()");
    });

    it("throws when a unit is triggered outside any scope", () => {
      const submitted = event<number>();

      expect(() => scoped(() => submitted(1))).toThrow("Scope is required");
    });
  });

  describe("the returned runner", () => {
    it("is a callable exposing run and wrap", () => {
      const runner = scoped(scope());

      expect(typeof runner).toBe("function");
      expect(typeof runner.run).toBe("function");
      expect(typeof runner.wrap).toBe("function");
    });

    it("exposes run as an identity-equal alias that executes fn", () => {
      const s = scope();
      const runner = scoped(s);

      expect(runner.run).toBe(runner);
      expect(runner(() => getCurrentScope())).toBe(s);
      expect(runner.run(() => getCurrentScope())).toBe(s);
    });

    it("reuses a runner for immediate work and stored callbacks", async () => {
      const appScope = scope();
      const count = store(0);
      const inAppScope = scoped(appScope);

      await inAppScope(async () => {
        await Promise.resolve();
        count.value += 1;
      });

      const addLater = inAppScope.wrap((amount: number) => {
        count.value += amount;
      });

      await Promise.resolve().then(() => addLater(2));

      inAppScope(() => {
        expect(count.value).toBe(3);
      });
    });

    describe("wrap", () => {
      it("runs a wrapped method in the captured scope with its this binding intact", () => {
        const s = scope();
        const runner = scoped(s);
        const seenScopes: (Scope | null)[] = [];

        const obj = {
          n: 5,
          add: runner.wrap(function (this: unknown, x: number): number {
            seenScopes.push(getCurrentScope());
            return (this as { n: number }).n + x;
          }),
        };

        expect(obj.add(2)).toBe(7);
        expect(seenScopes).toEqual([s]);
      });

      it("forwards multiple arguments and the return value", () => {
        const runner = scoped(scope());
        const f = runner.wrap((a: number, b: number) => a + b);

        expect(f(2, 3)).toBe(5);
      });

      it("awaits the work a wrapped async body triggers", async () => {
        const s = scope();
        const ev = event<number>();
        const value = store(0);

        reaction({ on: ev, run: (next: number) => (value.value = next) });

        const f = scoped(s).wrap(async () => {
          ev(5);
          await Promise.resolve();
        });

        await f();

        expect(scoped(s, () => value.value)).toBe(5);
      });

      it("captures the scope active at wrap-creation time", () => {
        const s = scope();
        const value = store(0);

        const callback = scoped(s, () =>
          scoped().wrap((amount: number) => {
            value.value += amount;
          }),
        );

        // Called at top level, with no ambient scope — must still run in s.
        expect(getCurrentScope()).toBe(null);
        callback(3);

        expect(scoped(s, () => value.value)).toBe(3);
      });

      it("wraps an external callback in the scope", async () => {
        const appScope = scope();
        const count = store(0);
        const callback = scoped(appScope).wrap((amount: number) => {
          count.value += amount;
        });

        await Promise.resolve().then(() => callback(2));

        scoped(appScope, () => {
          expect(count.value).toBe(2);
        });
      });

      it("wraps an external async callback in the scope", async () => {
        const appScope = scope();
        const count = store(0);
        const callback = scoped(appScope).wrap(async (amount: number) => {
          await Promise.resolve();
          count.value += amount;
        });

        await Promise.resolve().then(() => callback(2));

        scoped(appScope, () => {
          expect(count.value).toBe(2);
        });
      });

      it("captures the current scope when wrapping inside scoped", () => {
        const appScope = scope();
        const count = store(0);

        const callback = scoped(appScope, () =>
          scoped().wrap((amount: number) => {
            count.value += amount;
          }),
        );

        callback(3);

        scoped(appScope, () => {
          expect(count.value).toBe(3);
        });
      });
    });
  });

  describe("the scope-required error", () => {
    it("does not evaluate the describe thunk when a scope is active", () => {
      const s = scope();

      scoped(s, () => {
        let called = false;
        const got = requireActiveScope(() => {
          called = true;
          return "x";
        });

        expect(got).toBe(s);
        expect(called).toBe(false);
      });
    });

    it("includes the subject clause only when a subject is supplied", () => {
      const withSubject = scopeRequiredError('call event "submit"').message;
      const withoutSubject = scopeRequiredError().message;

      expect(withSubject).toContain('Scope is required to call event "submit", but no scope is active');
      expect(withoutSubject).toContain("Scope is required, but no scope is active");
      expect(withoutSubject).not.toContain(" to ");
    });

    it("includes the unit path trace during synchronous propagation", async () => {
      const captured: Error[] = [];

      const inner = node({
        meta: withInspectorMeta(undefined, { type: "event", name: "b", callable: true }),
        run: () => {
          captured.push(scopeRequiredError('call event "submit"'));
        },
      });
      const outer = node({
        meta: withInspectorMeta(undefined, { type: "event", name: "a", callable: true }),
        run: (ctx) => {
          // Reentrant run keeps `outer` on the node stack while `inner` runs.
          void run({ unit: inner, scope: ctx.scope ?? undefined });
        },
      });

      const s = scope();
      await run({ unit: outer, scope: s });

      expect(captured).toHaveLength(1);
      const message = captured[0].message;
      expect(message).toContain("Unit path that led here:");
      expect(message).toContain('event "a"');
      expect(message).toContain('event "b"');
      expect(message).toContain(" → ");
      expect(message).toContain("raw `await`");
    });

    it("lists all three remedies", () => {
      const message = scopeRequiredError().message;

      expect(message).toContain("Run inside a scoped computation");
      expect(message).toContain("Trigger the unit from within an effect handler");
      expect(message).toContain("read and trigger units through the scope Provider");
    });
  });
});
