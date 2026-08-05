import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computed, effect, event, reaction, scope, scoped, store } from "../../lib";
import { flush } from "../support/async-flush";

// The console report is a product feature: someone reading it with no devtools
// attached must learn what failed, where it was declared, and which chain of
// units led there. These assertions pin that quality.
describe("failure diagnostics", () => {
  let logged: string[];

  beforeEach(() => {
    logged = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      logged.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(" "));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("names the failing unit when the reaction has a name", () => {
    const s = scope();
    const $token = store("", undefined, { name: "$token" });

    reaction({
      name: "connectSocket",
      on: $token,
      run: () => {
        throw new Error("handshake rejected");
      },
    });

    scoped(s, () => {
      $token.value = "abc";
    });

    expect(logged[0]).toContain('reaction "connectSocket"');
  });

  it("points at the declaration site even when the reaction is anonymous", () => {
    const s = scope();
    const $n = store(0);

    reaction({
      on: $n,
      run: () => {
        throw new Error("boom");
      },
    });

    scoped(s, () => {
      $n.value = 1;
    });

    expect(logged[0]).toContain("declared at:");
    expect(logged[0]).toMatch(/failure-diagnostics\.test\.ts:\d+/);
  });

  it("prints the propagation chain through named units", () => {
    const s = scope();
    const $token = store("", undefined, { name: "$token" });
    const $authorized = computed(() => Boolean($token.value), undefined, {
      name: "$authorized",
    });

    reaction({
      name: "connect",
      on: $authorized,
      run: () => {
        throw new Error("boom");
      },
    });

    scoped(s, () => {
      $token.value = "abc";
    });

    expect(logged[0]).toContain("propagation path:");
    expect(logged[0]).toContain('store "$token"');
    expect(logged[0]).toContain('computed "$authorized"');
    expect(logged[0]).toContain('reaction "connect"');
  });

  it("hides internal plumbing nodes from the chain", () => {
    const s = scope();
    const $token = store("", undefined, { name: "$token" });
    const $flag = $token.map(Boolean);

    reaction({
      name: "connect",
      on: $flag,
      run: () => {
        throw new Error("boom");
      },
    });

    scoped(s, () => {
      $token.value = "abc";
    });

    expect(logged[0]).not.toContain("invalidate");
  });

  it("identifies the scope", () => {
    const s = scope();
    const $n = store(0);

    reaction({
      on: $n,
      run: () => {
        throw new Error("boom");
      },
    });

    scoped(s, () => {
      $n.value = 1;
    });

    expect(logged[0]).toMatch(/scope: scope:\d+/);
  });

  it("states that other branches survived and that an awaited trigger rejects", () => {
    const s = scope();
    const $n = store(0);

    reaction({
      on: $n,
      run: () => {
        throw new Error("boom");
      },
    });

    scoped(s, () => {
      $n.value = 1;
    });

    expect(logged[0]).toContain("independent branches");
    expect(logged[0]).toContain("reject");
  });

  it("preserves the original error so the console keeps its stack", () => {
    const s = scope();
    const $n = store(0);
    const original = new Error("keep-me");

    reaction({
      on: $n,
      run: () => {
        throw original;
      },
    });

    scoped(s, () => {
      $n.value = 1;
    });

    expect(logged[0]).toContain("keep-me");
  });

  it("names the store behind a failing subscriber", () => {
    const s = scope();
    const $n = store(0, undefined, { name: "$counter" });

    $n.subscribe(() => {
      throw new Error("boom");
    });

    scoped(s, () => {
      $n.value = 1;
    });

    expect(logged[0]).toContain("store subscriber");
    expect(logged[0]).toContain('store "$counter"');
  });

  it("reports an async reaction failure with the same shape", async () => {
    const s = scope();
    const go = event<number>();
    const fx = effect(async () => 1);

    reaction({
      name: "asyncRule",
      on: go,
      run: async () => {
        await fx();
        throw new Error("late boom");
      },
    });

    await scoped(s, () => go(1)).catch(() => undefined);
    await flush(40);

    expect(logged.join("\n")).toContain('reaction "asyncRule"');
    expect(logged.join("\n")).toContain("late boom");
  });
});
