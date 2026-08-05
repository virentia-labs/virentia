import { describe, expect, it } from "vitest";
import { serializeDevtoolsValue } from "../../lib/devtools";

// The inspector serializes arbitrary user values off the hot path. It must never
// be the thing that takes an app down: no throw, no hang, no unbounded output.
describe("devtools value serialization under load", () => {
  it("survives a self-referential object", () => {
    const cyclic: Record<string, unknown> = { name: "root" };
    cyclic.self = cyclic;

    expect(() => serializeDevtoolsValue(cyclic)).not.toThrow();
  });

  it("survives mutual references", () => {
    const a: Record<string, unknown> = {};
    const b: Record<string, unknown> = { a };
    a.b = b;

    expect(() => serializeDevtoolsValue(a)).not.toThrow();
  });

  it("survives a deep chain without blowing the stack", () => {
    let deep: Record<string, unknown> = { leaf: true };

    for (let i = 0; i < 5000; i += 1) {
      deep = { next: deep };
    }

    expect(() => serializeDevtoolsValue(deep)).not.toThrow();
  });

  it("survives a wide object", () => {
    const wide: Record<string, number> = {};

    for (let i = 0; i < 20000; i += 1) {
      wide[`k${i}`] = i;
    }

    expect(() => serializeDevtoolsValue(wide)).not.toThrow();
  });

  it("survives a large array", () => {
    const list = Array.from({ length: 50000 }, (_, i) => i);

    expect(() => serializeDevtoolsValue(list)).not.toThrow();
  });

  it("survives a getter that throws", () => {
    const hostile = {
      get boom(): never {
        throw new Error("nope");
      },
    };

    expect(() => serializeDevtoolsValue(hostile)).not.toThrow();
  });

  it("survives exotic primitives and built-ins", () => {
    const values: unknown[] = [
      undefined,
      null,
      Number.NaN,
      Infinity,
      -0,
      0n,
      Symbol("s"),
      () => 1,
      new Date(0),
      /re/g,
      new Map([[1, 2]]),
      new Set([1]),
      new Error("e"),
      Object.create(null),
      new Uint8Array([1, 2, 3]),
      Promise.resolve(1),
    ];

    for (const value of values) {
      expect(() => serializeDevtoolsValue(value)).not.toThrow();
    }
  });

  it("survives a proxy that throws on access", () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error("trap");
        },
        ownKeys() {
          throw new Error("keys");
        },
      },
    );

    expect(() => serializeDevtoolsValue(hostile)).not.toThrow();
  });

  it("produces a bounded result for a large input", () => {
    const list = Array.from({ length: 50000 }, (_, i) => `item-${i}`);
    const size = JSON.stringify(serializeDevtoolsValue(list) ?? null).length;

    // A snapshot shipped over the wire must not scale with the whole heap.
    expect(size).toBeLessThan(2_000_000);
  });
});
