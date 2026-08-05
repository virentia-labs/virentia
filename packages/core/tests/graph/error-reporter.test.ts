import { afterEach, describe, expect, it, vi } from "vitest";
import {
  computed,
  reaction,
  scope,
  scoped,
  setErrorReporter,
  store,
  type VirentiaFailureReport,
} from "../../lib";

describe("setErrorReporter", () => {
  afterEach(() => {
    setErrorReporter(null);
    vi.restoreAllMocks();
  });

  it("routes failures to a custom reporter instead of the console", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const received: VirentiaFailureReport[] = [];

    setErrorReporter((failure) => received.push(failure));

    const s = scope();
    const $a = store(0);

    reaction({
      name: "rule",
      on: $a,
      run: () => {
        throw new Error("boom");
      },
    });

    scoped(s, () => {
      $a.value = 1;
    });

    expect(received).toHaveLength(1);
    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it("hands over structured fields, not just a string", () => {
    const received: VirentiaFailureReport[] = [];

    setErrorReporter((failure) => received.push(failure));

    const s = scope();
    const $token = store("", undefined, { name: "$token" });
    const $authorized = computed(() => Boolean($token.value), undefined, {
      name: "$authorized",
    });
    const original = new Error("handshake");

    reaction({
      name: "connect",
      on: $authorized,
      run: () => {
        throw original;
      },
    });

    scoped(s, () => {
      $token.value = "abc";
    });

    const failure = received[0]!;

    expect(failure.kind).toBe("reaction");
    expect(failure.unit).toBe('reaction "connect"');
    expect(failure.error).toBe(original);
    expect(failure.scope).toMatch(/^scope:\d+$/);
    expect(failure.path).toEqual([
      'store "$token"',
      'computed "$authorized"',
      'reaction "connect"',
    ]);
    expect(failure.declaredAt).toMatch(/error-reporter\.test\.ts:\d+/);
    expect(failure.message).toContain("[virentia]");
  });

  it("restores the console default when passed null", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    setErrorReporter(() => {});
    setErrorReporter(null);

    const s = scope();
    const $a = store(0);

    reaction({
      on: $a,
      run: () => {
        throw new Error("boom");
      },
    });

    scoped(s, () => {
      $a.value = 1;
    });

    expect(consoleSpy).toHaveBeenCalled();
  });

  it("falls back to the console when the reporter itself throws", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    setErrorReporter(() => {
      throw new Error("reporter is broken");
    });

    const s = scope();
    const $a = store(0);
    const seen: number[] = [];

    reaction({
      on: $a,
      run: () => {
        throw new Error("boom");
      },
    });
    reaction({ on: $a, run: (v: number) => seen.push(v) });

    scoped(s, () => {
      $a.value = 1;
    });

    // The failure is still visible, and the update still ran its other branch.
    expect(consoleSpy).toHaveBeenCalled();
    expect(seen).toEqual([1]);
  });

  it("silences reporting when the app wants to handle it entirely", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let count = 0;

    setErrorReporter(() => {
      count += 1;
    });

    const s = scope();
    const $a = store(0);

    reaction({
      on: $a,
      run: () => {
        throw new Error("boom");
      },
    });

    scoped(s, () => {
      $a.value = 1;
    });
    scoped(s, () => {
      $a.value = 2;
    });

    expect(count).toBe(2);
    expect(consoleSpy).not.toHaveBeenCalled();
  });
});
