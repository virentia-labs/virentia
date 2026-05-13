import { describe, expect, it } from "vitest";
import { createContext, scope, scoped, store, withContexts } from "../lib";

describe("scope", () => {
  it("makes scoped stores read and write from the current scoped frame", () => {
    const outer = scope();
    const inner = scope();
    const value = store(0);

    scoped(outer, () => {
      value.value = 1;

      scoped(inner, () => {
        expect(value.value).toBe(0);
        value.value = 2;
      });

      expect(value.value).toBe(1);
    });

    scoped(inner, () => {
      expect(value.value).toBe(2);
    });
    expect(() => value.value).toThrow("Scope is required");
  });

  it("creates a scope with initial store values", () => {
    const value = store(0);
    const appScope = scope({
      values: [[value, 10]],
    });

    scoped(appScope, () => {
      expect(value.value).toBe(10);
    });
  });

  it("keeps the current scope across awaited scoped work", async () => {
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

  it("uses the current scope when scoped is called without an explicit scope", () => {
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

  it("creates a scoped runner for immediate work and stored callbacks", async () => {
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

  it("keeps the current scope across awaited scoped work", async () => {
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

  it("keeps the current scope across several scoped awaits", async () => {
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

  it("wraps external callbacks in a scope", async () => {
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

  it("wraps external async callbacks in a scope", async () => {
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

describe("kernel contexts outside run", () => {
  it("supports scoped user contexts in plain production code", () => {
    const requestId = createContext<string>();
    const seen: unknown[] = [];

    withContexts([requestId.setup("outer")], () => {
      seen.push(requestId.has(), requestId.get());

      withContexts([requestId.setup("inner")], () => {
        seen.push(requestId.get());
        requestId.set("updated");
        seen.push(requestId.get());
      });

      seen.push(requestId.get());
      requestId.delete();
      seen.push(requestId.has(), requestId.get("fallback"));
    });

    expect(seen).toEqual([true, "outer", "inner", "updated", "outer", false, "fallback"]);
  });
});
