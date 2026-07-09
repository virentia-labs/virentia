import { describe, expect, it } from "vitest";
import { getOwner, onCleanup, owner, withOwner } from "../../lib";
import type { Owner } from "../../lib";
import { registerCleanup } from "../../lib/graph/owner";

// The Symbol.dispose the source resolves to (native where available, otherwise a
// polyfilled `Symbol.for("Symbol.dispose")`).
const disposeSymbol: symbol =
  typeof Symbol.dispose === "symbol" ? Symbol.dispose : Symbol.for("Symbol.dispose");

// Internal OwnerState shape, for algorithmic probes of the private cleanup array.
interface OwnerInternals {
  disposed: boolean;
  cleanups: Array<() => void>;
}

const internals = (o: Owner): OwnerInternals => o as unknown as OwnerInternals;

// Create a live, non-disposed standalone owner for withOwner-driven probes.
const makeOwner = (): Owner => owner((_dispose, o) => ({ o })).o;

describe("owner", () => {
  it("returns fn's object result by identity", () => {
    const obj = { a: 1 };
    const m = owner(() => obj);

    expect(m).toBe(obj);
    expect(m.a).toBe(1);
  });

  it("returns a primitive result unchanged with no attachment", () => {
    const m = owner(() => 42);

    expect(m).toBe(42);
    expect((m as unknown as { dispose?: unknown }).dispose).toBeUndefined();
  });

  it("attaches dispose to a function result", () => {
    const f = (): void => {};
    const m = owner(() => f);

    expect(m).toBe(f);
    expect(typeof (m as unknown as { dispose: unknown }).dispose).toBe("function");
    expect(typeof (m as unknown as Record<symbol, unknown>)[disposeSymbol]).toBe("function");
  });

  it("attaches dispose and Symbol.dispose as non-enumerable, configurable, non-writable properties", () => {
    const m = owner(() => ({ value: 1 }));

    expect(Object.keys(m)).toEqual(["value"]);

    const desc = Object.getOwnPropertyDescriptor(m, "dispose")!;
    expect(desc.enumerable).toBe(false);
    expect(desc.configurable).toBe(true);
    expect(desc.writable).toBe(false);
    expect(typeof desc.value).toBe("function");

    const symDesc = Object.getOwnPropertyDescriptor(m, disposeSymbol)!;
    expect(symDesc.enumerable).toBe(false);
    expect(symDesc.configurable).toBe(true);
  });

  it("preserves a pre-existing own dispose without running owner cleanups", () => {
    const calls: string[] = [];
    const custom = (): void => {
      calls.push("own");
    };
    const m = owner(() => {
      onCleanup(() => calls.push("cleanup"));
      return { dispose: custom };
    });

    // Own `dispose` is untouched; the owner's Symbol.dispose is still attached.
    expect(m.dispose).toBe(custom);
    expect(typeof (m as unknown as Record<symbol, unknown>)[disposeSymbol]).toBe("function");

    m.dispose();
    expect(calls).toEqual(["own"]); // owner cleanup did NOT run
  });

  it("leaves an inherited dispose unshadowed by an own property", () => {
    const protoDispose = function protoDispose(this: unknown): void {};

    class C {
      dispose = protoDispose;
    }
    // Put dispose on the prototype specifically (not an own instance field).
    class D {}
    (D.prototype as unknown as { dispose: unknown }).dispose = protoDispose;

    const m = owner(() => new D());

    expect(Object.prototype.hasOwnProperty.call(m, "dispose")).toBe(false);
    expect((m as unknown as { dispose: unknown }).dispose).toBe(protoDispose);
    // Symbol.dispose was NOT inherited, so it does get attached as an own prop.
    expect(Object.prototype.hasOwnProperty.call(m, disposeSymbol)).toBe(true);

    void C; // referenced to keep the illustrative class alive for readers
  });

  it("makes getOwner the fresh owner inside fn, then null after return", () => {
    let seen: Owner | null = null;
    const m = owner((_dispose, o) => {
      seen = getOwner();
      return { o };
    });

    expect(seen).toBe(m.o);
    expect(getOwner()).toBe(null);
  });

  it("activates a nested owner for its body, then restores the outer", () => {
    owner((_d, outer) => {
      expect(getOwner()).toBe(outer);

      owner((_d2, inner) => {
        expect(getOwner()).toBe(inner);
        expect(inner).not.toBe(outer);
        return {};
      });

      expect(getOwner()).toBe(outer);
      return {};
    });

    expect(getOwner()).toBe(null);
  });

  it("disposes a nested owner independently of the outer", () => {
    const calls: string[] = [];
    let innerRef!: Owner;

    const outer = owner((_d, o) => {
      onCleanup(() => calls.push("A"));
      const inner = owner((_d2, io) => {
        onCleanup(() => calls.push("B"));
        return { io };
      });
      innerRef = inner.io;
      return { o };
    });

    innerRef.dispose();
    expect(calls).toEqual(["B"]);

    outer.dispose();
    expect(calls).toEqual(["B", "A"]);
  });

  it("restores a nested owner to the enclosing owner, not null", () => {
    const parent = makeOwner();

    withOwner(parent, () => {
      owner((_d, o) => {
        expect(getOwner()).toBe(o);
        return {};
      });
      // previousOwner (parent) restored, NOT null.
      expect(getOwner()).toBe(parent);
    });

    expect(getOwner()).toBe(null);
  });

  it("disposes the owner when fn throws, then rethrows", () => {
    const calls: string[] = [];

    expect(() =>
      owner(() => {
        onCleanup(() => calls.push("c"));
        throw new Error("boom");
      }),
    ).toThrow("boom");

    expect(calls).toEqual(["c"]);
    expect(getOwner()).toBe(null);
  });

  it("disposes the same owner via the thunk argument or owner.dispose()", () => {
    const viaThunk: string[] = [];
    let thunk!: () => void;
    const a = owner((dispose, o) => {
      thunk = dispose;
      onCleanup(() => viaThunk.push("x"));
      return { o };
    });
    thunk();
    expect(viaThunk).toEqual(["x"]);
    expect(a.o.disposed).toBe(true);

    const viaMethod: string[] = [];
    const b = owner((_d, o) => {
      onCleanup(() => viaMethod.push("y"));
      return { o };
    });
    b.o.dispose();
    expect(viaMethod).toEqual(["y"]);
    expect(b.o.disposed).toBe(true);
  });

  it("flips owner.disposed from false to true on disposal", () => {
    const m = owner((_d, o) => ({ o }));

    expect(m.o.disposed).toBe(false);
    m.o.dispose();
    expect(m.o.disposed).toBe(true);
  });

  describe("cleanup", () => {
    it("runs cleanups in LIFO order", () => {
      const calls: string[] = [];
      const m = owner((_d, o) => {
        onCleanup(() => calls.push("a"));
        onCleanup(() => calls.push("b"));
        onCleanup(() => calls.push("c"));
        return { o };
      });

      m.o.dispose();
      expect(calls).toEqual(["c", "b", "a"]);
    });

    it("runs cleanups only once on a double dispose", () => {
      const calls: string[] = [];
      const m = owner((_d, o) => {
        onCleanup(() => calls.push("x"));
        return { o };
      });

      m.o.dispose();
      m.o.dispose();
      expect(calls).toEqual(["x"]);
    });

    it("runs cleanups once across Symbol.dispose then dispose", () => {
      const calls: string[] = [];
      const m = owner((_d, o) => {
        onCleanup(() => calls.push("x"));
        return { o };
      });

      (m.o as unknown as Record<symbol, () => void>)[disposeSymbol]();
      m.o.dispose();
      expect(calls).toEqual(["x"]);
    });

    it("skips a cleanup removed by its unregister function", () => {
      const calls: string[] = [];
      const m = owner((_d, o) => {
        const off = onCleanup(() => calls.push("c"));
        off();
        return { o };
      });

      m.o.dispose();
      expect(calls).toEqual([]);
    });

    it("keeps the remaining cleanups when one is unregistered", () => {
      const calls: string[] = [];
      const m = owner((_d, o) => {
        onCleanup(() => calls.push("1"));
        const off2 = onCleanup(() => calls.push("2"));
        onCleanup(() => calls.push("3"));
        off2();
        return { o };
      });

      m.o.dispose();
      expect(calls).toEqual(["3", "1"]);
    });

    it("returns a noop from onCleanup with no active owner", () => {
      const calls: string[] = [];
      expect(getOwner()).toBe(null);

      const off = onCleanup(() => calls.push("x"));

      expect(typeof off).toBe("function");
      expect(() => off()).not.toThrow();
      expect(calls).toEqual([]);
    });

    it("runs a late onCleanup immediately on an already-disposed owner", () => {
      const calls: string[] = [];
      const m = owner((_d, o) => ({ o }));
      m.o.dispose();

      let off!: () => void;
      withOwner(m.o, () => {
        off = onCleanup(() => calls.push("late"));
      });

      expect(calls).toEqual(["late"]);
      expect(() => off()).not.toThrow();
    });

    it("runs the remaining cleanups when one throws, then rethrows the captured error", () => {
      const calls: string[] = [];
      const m = owner((_d, o) => {
        onCleanup(() => calls.push("a")); // runs last (LIFO)
        onCleanup(() => {
          throw new Error("e2"); // runs second
        });
        onCleanup(() => calls.push("c")); // runs first
        return { o };
      });

      expect(() => m.o.dispose()).toThrow("e2");
      // Both non-throwing cleanups still ran, on either side of the thrower.
      expect(calls).toEqual(["c", "a"]);
      expect(m.o.disposed).toBe(true);
    });

    it("propagates only the first-run error when several cleanups throw", () => {
      const errX = new Error("errX");
      const errY = new Error("errY");
      const m = owner((_d, o) => {
        // Registered first => runs LAST.
        onCleanup(() => {
          throw errY;
        });
        // Registered last => runs FIRST.
        onCleanup(() => {
          throw errX;
        });
        return { o };
      });

      expect(() => m.o.dispose()).toThrow(errX);
    });

    it("runs an onCleanup registered reentrantly during a cleanup", () => {
      const calls: string[] = [];
      const m = owner((_d, o) => {
        onCleanup(() => {
          calls.push("outer");
          withOwner(o, () => onCleanup(() => calls.push("reentrant")));
        });
        return { o };
      });

      m.o.dispose();
      expect(calls).toEqual(["outer", "reentrant"]);
    });

    it("swaps the cleanups array to a fresh one before iterating", () => {
      const m = owner((_d, o) => {
        onCleanup(() => {});
        onCleanup(() => {});
        return { o };
      });

      expect(internals(m.o).cleanups.length).toBe(2);
      m.o.dispose();
      expect(internals(m.o).cleanups).toEqual([]);
    });

    it("ignores an unregister call made after disposal", () => {
      let off!: () => void;
      const m = owner((_d, o) => {
        off = onCleanup(() => {});
        return { o };
      });

      m.o.dispose();
      expect(() => off()).not.toThrow();
    });

    it("runs a twice-registered function twice on dispose", () => {
      const calls: string[] = [];
      const fn = (): void => {
        calls.push("x");
      };
      const m = owner((_d, o) => {
        onCleanup(fn);
        onCleanup(fn);
        return { o };
      });

      m.o.dispose();
      expect(calls).toEqual(["x", "x"]);
    });

    it("unregisters only the first occurrence of a duplicated function", () => {
      const calls: string[] = [];
      const fn = (): void => {
        calls.push("x");
      };
      const m = owner((_d, o) => {
        const u1 = onCleanup(fn);
        onCleanup(fn);
        u1();
        return { o };
      });

      m.o.dispose();
      expect(calls).toEqual(["x"]);
    });

    it("runs a cleanup registered through registerCleanup", () => {
      const calls: string[] = [];
      const m = owner((_d, o) => {
        registerCleanup(() => calls.push("r"));
        return { o };
      });

      m.o.dispose();
      expect(calls).toEqual(["r"]);
    });

    it("returns a noop from registerCleanup with no active owner", () => {
      const calls: string[] = [];
      expect(getOwner()).toBe(null);

      const off = registerCleanup(() => calls.push("x"));
      expect(typeof off).toBe("function");
      expect(calls).toEqual([]);
    });
  });

  describe("withOwner", () => {
    it("restores the saved previous owner on nesting, not null", () => {
      const a = makeOwner();
      const b = makeOwner();

      withOwner(a, () => {
        expect(getOwner()).toBe(a);
        withOwner(b, () => {
          expect(getOwner()).toBe(b);
        });
        expect(getOwner()).toBe(a);
      });

      expect(getOwner()).toBe(null);
    });

    it("keeps the current owner when passed null", () => {
      const calls: string[] = [];
      const existing = makeOwner();

      withOwner(existing, () => {
        withOwner(null, () => {
          expect(getOwner()).toBe(existing);
          onCleanup(() => calls.push("c"));
        });
      });

      existing.dispose();
      expect(calls).toEqual(["c"]);
    });

    it("installs no owner when passed null at top level", () => {
      const calls: string[] = [];
      expect(getOwner()).toBe(null);

      withOwner(null, () => {
        expect(getOwner()).toBe(null);
        onCleanup(() => calls.push("x"));
      });

      expect(calls).toEqual([]);
    });

    it("restores the active owner without disposing when fn throws", () => {
      const m = owner((_d, o) => ({ o }));

      expect(() =>
        withOwner(m.o, () => {
          throw new Error("x");
        }),
      ).toThrow("x");

      expect(m.o.disposed).toBe(false);
      expect(getOwner()).toBe(null);
    });

    it("returns fn's return value", () => {
      const a = makeOwner();
      const result = withOwner(a, () => 123);
      expect(result).toBe(123);
    });
  });
});
