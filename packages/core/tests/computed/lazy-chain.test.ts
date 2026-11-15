import { describe, expect, it, vi } from "vitest";
import { computed, reaction, scope, scoped, store } from "../../lib";
import { node, type Node } from "../../lib/internal";
import { collectNodes } from "../../lib/graph/deps";

describe("computed chain invalidation", () => {
  it("tracks extra inputs of maps in addition to their structural parent", () => {
    const app = scope(),
      source = store(2),
      rate = store(3);
    const middle = source.map((value) => value * 2);
    const terminal = middle.map((value) => value * rate.value);
    const seen: number[] = [];
    const observer = reaction({
      scope: app,
      on: terminal,
      run: (value) => {
        seen.push(value);
      },
    });
    try {
      scoped(app, () => {
        expect(terminal.value).toBe(12);
        rate.value = 4;
        expect(terminal.value).toBe(16);
        source.value = 3;
        expect(terminal.value).toBe(24);
      });
      expect(seen).toEqual([16, 24]);
    } finally {
      observer.stop();
    }
  });

  it("keeps conditional extra map inputs precise and independent per scope", () => {
    const a = scope(),
      b = scope(),
      source = store(1),
      chooseA = store(true),
      left = store(10),
      right = store(20);
    let calls = 0;
    const terminal = source
      .map((value) => value * 2)
      .map((value) => {
        calls++;
        return value + (chooseA.value ? left.value : right.value);
      });
    expect(scoped(a, () => terminal.value)).toBe(12);
    scoped(b, () => {
      chooseA.value = false;
    });
    expect(scoped(b, () => terminal.value)).toBe(22);
    calls = 0;
    scoped(a, () => {
      right.value = 30;
      expect(terminal.value).toBe(12);
    });
    scoped(b, () => {
      left.value = 40;
      expect(terminal.value).toBe(22);
    });
    expect(calls).toBe(0);
    scoped(a, () => {
      left.value = 50;
      expect(terminal.value).toBe(52);
    });
    scoped(b, () => {
      right.value = 60;
      expect(terminal.value).toBe(62);
    });
    expect(calls).toBe(2);
  });

  it("preserves full public collectors nested inside a native map", () => {
    const app = scope(),
      source = store(2),
      extra = store(3);
    const parent = source.map((value) => value + 1);
    const terminal = parent.map((value) => {
      const captured = collectNodes(() => parent.value + extra.value);
      expect(captured.nodes).toEqual(new Set([parent.node, extra.node]));
      return value + captured.result;
    });
    expect(scoped(app, () => terminal.value)).toBe(9);
    scoped(app, () => {
      source.value = 3;
    });
    expect(scoped(app, () => terminal.value)).toBe(11);
  });

  it("takes a fresh comparison value when a previously lazy chain becomes observed", () => {
    const app = scope(),
      source = store(0),
      middle = source.map((value) => value * 2);
    const terminal = middle.map((value) => value);
    scoped(app, () => {
      expect(terminal.value).toBe(0);
      source.value = 1;
      expect(terminal.value).toBe(2);
    });
    const seen: number[] = [];
    const unsubscribe = terminal.subscribe((value) => seen.push(value));
    try {
      scoped(app, () => {
        source.value = 0;
      });
      expect(seen).toEqual([0]);
    } finally {
      unsubscribe();
    }
  });

  it("does not defer a branch with skip tokens or lose an intermediate accepted value", () => {
    const app = scope(),
      source = store(0);
    const terminal = source
      .map((value) => value)
      .filter((value) => value % 2 === 0)
      .map((value) => value + 100);
    scoped(app, () => {
      expect(terminal.value).toBe(100);
      for (const value of [2, 3, 4, 5]) source.value = value;
      expect(terminal.value).toBe(104);
    });
  });

  it("retains normal notifications when any reachable branch has a subscriber", () => {
    const app = scope(),
      source = store(0),
      middle = source.map((value) => value * 2);
    const terminal = middle.map((value) => value + 1),
      seen: number[] = [];
    const unsubscribe = middle.subscribe((value) => seen.push(value));
    try {
      scoped(app, () => {
        expect(terminal.value).toBe(1);
        source.value = 1;
        source.value = 2;
        expect(terminal.value).toBe(5);
      });
      expect(seen).toEqual([2, 4]);
    } finally {
      unsubscribe();
    }
  });

  it("keeps cached chains independent in simultaneous application scopes", () => {
    const a = scope(),
      b = scope(),
      source = store(0);
    const terminal = source.map((value) => value + 1).map((value) => value * 2);
    expect(scoped(a, () => terminal.value)).toBe(2);
    expect(scoped(b, () => terminal.value)).toBe(2);
    scoped(a, () => {
      source.value = 4;
    });
    expect(scoped(b, () => terminal.value)).toBe(2);
    expect(scoped(a, () => terminal.value)).toBe(10);
  });

  it("handles dynamically selected upstream sources without sharing scope dependencies", () => {
    const app = scope(),
      chooseA = store(true),
      a = store(1),
      b = store(5);
    const selected = computed(() => (chooseA.value ? a.value : b.value));
    const terminal = selected.map((value) => value * 2);
    scoped(app, () => {
      expect(terminal.value).toBe(2);
      chooseA.value = false;
      b.value = 7;
      expect(terminal.value).toBe(14);
      a.value = 9;
      expect(terminal.value).toBe(14);
      chooseA.value = true;
      expect(terminal.value).toBe(18);
    });
  });

  it("does not bypass an overridden native computed node", () => {
    const app = scope(),
      source = store(0),
      middle = source.map((value) => value + 1);
    const terminal = middle.map((value) => value + 1),
      node = middle.node as Node;
    const original = node.run!,
      run = vi.fn(original);
    node.run = run;
    try {
      scoped(app, () => {
        source.value = 1;
        expect(terminal.value).toBe(3);
      });
      expect(run).toHaveBeenCalledTimes(1);
    } finally {
      node.run = original;
    }
  });

  for (const getter of [false, true]) {
    it(`keeps the regular propagation path for a custom value-map ${getter ? "getter" : "method"}`, () => {
      const app = scope(),
        source = store(0),
        calls = vi.fn((value: number) => value + 1);
      const middle = source.map(calls),
        terminal = middle.map((value) => value + 1);
      scoped(app, () => {
        expect(terminal.value).toBe(2);
      });
      const values = app.values;
      if (getter) Object.defineProperty(app, "values", { configurable: true, get: () => values });
      else
        Object.defineProperty(values, "get", {
          configurable: true,
          value: vi.fn(values.get.bind(values)),
        });
      calls.mockClear();
      scoped(app, () => {
        source.value = 1;
      });
      // Only an unobserved computed reads it: it is pulled when that one is read.
      expect(scoped(app, () => terminal.value)).toBe(3);
      expect(calls).toHaveBeenCalledTimes(1);
    });
  }

  it("honours an accessor-backed computed runner", () => {
    const app = scope(),
      source = store(0),
      calls = vi.fn((value: number) => value + 1);
    const middle = source.map(calls),
      terminal = middle.map((value) => value + 1);
    const node = middle.node as Node,
      original = Object.getOwnPropertyDescriptor(node, "run")!;
    const read = vi.fn(() => original.value);
    Object.defineProperty(node, "run", { configurable: true, get: read });
    try {
      scoped(app, () => {
        source.value = 1;
      });
      expect(read).toHaveBeenCalled();
      // Only an unobserved computed reads it: it is pulled when that one is read.
      expect(scoped(app, () => terminal.value)).toBe(3);
      expect(calls).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(node, "run", original);
    }
  });

  it("propagates after a scoped reaction attaches to a previously read chain", () => {
    const app = scope(),
      source = store(0);
    const terminal = source.map((value) => value + 1).map((value) => value + 1);
    scoped(app, () => {
      source.value = 1;
      expect(terminal.value).toBe(3);
    });
    const seen: number[] = [];
    const observer = reaction({
      scope: app,
      on: terminal,
      run: (value) => {
        seen.push(value);
      },
    });
    try {
      scoped(app, () => {
        source.value = 2;
      });
      expect(seen).toEqual([4]);
    } finally {
      observer.stop();
    }
  });

  it("honours native runner replacement and restoration after cache reads", () => {
    const app = scope(),
      source = store(0),
      middle = source.map((value) => value + 1);
    const terminal = middle.map((value) => value + 1),
      output = middle.node as Node;
    scoped(app, () => {
      source.value = 1;
      expect(terminal.value).toBe(3);
    });
    const original = output.run!,
      run = vi.fn(original);
    output.run = run;
    try {
      scoped(app, () => {
        source.value = 2;
      });
      expect(run).toHaveBeenCalledTimes(1);
      expect(scoped(app, () => terminal.value)).toBe(4);
    } finally {
      output.run = original;
    }
    scoped(app, () => {
      source.value = 3;
      expect(terminal.value).toBe(5);
    });
  });

  it("honours direct successor-array mutations after cache reads", () => {
    const app = scope(),
      source = store(0),
      middle = source.map((value) => value + 1);
    const terminal = middle.map((value) => value + 1),
      seen: unknown[] = [];
    scoped(app, () => {
      source.value = 1;
      expect(terminal.value).toBe(3);
    });
    const external = node((ctx) => {
      seen.push(ctx.value);
    });
    middle.node.next!.push(external);
    scoped(app, () => {
      source.value = 2;
    });
    expect(seen).toEqual([3]);
    expect(scoped(app, () => terminal.value)).toBe(4);
    middle.node.next!.splice(middle.node.next!.indexOf(external), 1);
    scoped(app, () => {
      source.value = 3;
      expect(terminal.value).toBe(5);
    });
  });

  it("honours successor replacement arrays after cache reads", () => {
    const app = scope(),
      source = store(0),
      calls = vi.fn((value: number) => value + 1);
    const middle = source.map(calls),
      terminal = middle.map((value) => value + 1);
    scoped(app, () => {
      source.value = 1;
      expect(terminal.value).toBe(3);
    });
    source.node.next = [...source.node.next!];
    calls.mockClear();
    scoped(app, () => {
      source.value = 2;
    });
    // Only an unobserved computed reads it: it is pulled when that one is read.
    expect(scoped(app, () => terminal.value)).toBe(4);
    expect(calls).toHaveBeenCalledTimes(1);
  });
});
