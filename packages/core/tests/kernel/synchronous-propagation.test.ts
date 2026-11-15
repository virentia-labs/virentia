import { describe, expect, it, vi } from "vitest";
import { computed, event, reaction, scope, scoped, setErrorReporter, store } from "../../lib";
import {
  node,
  reconcileScopedEdges,
  registerSynchronousSink,
  runDetached,
  writeTransactionStore,
  type Node,
} from "../../lib/internal";
import { onInspectorEvent } from "../../lib/kernel/inspector";

// A commit whose graph holds only computeds and terminal sinks propagates in
// place; the same scenario with the inspector on goes through the kernel queue.
// Every observable outcome must be identical.
async function bothPaths<T>(scenario: () => T | Promise<T>): Promise<[kernel: T, inPlace: T]> {
  const off = onInspectorEvent(() => {});
  let kernel: T;
  try {
    kernel = await scenario();
  } finally {
    off();
  }
  return [kernel, await scenario()];
}

describe("synchronous propagation through pure computeds", () => {
  it("notifies and evaluates in the kernel's order through maps, diamonds and filters", async () => {
    const [kernel, inPlace] = await bothPaths(() => {
      const app = scope(),
        source = store(0),
        log: string[] = [];
      const calls: Record<string, number> = {};
      const count =
        <T>(name: string, fn: () => T) =>
        () => {
          calls[name] = (calls[name] ?? 0) + 1;
          return fn();
        };
      const a = source.map((value) => value + 1);
      const b = computed(count("b", () => source.value * 2));
      const middle = computed(count("middle", () => a.value * 10));
      const c = computed(count("c", () => middle.value + b.value));
      const even = a.filter((value) => value % 2 === 0);
      const shifted = even.map((value) => value + 100);
      const update = vi.spyOn(Object.getPrototypeOf(b.node), "runUpdate");
      const offs = [
        a.subscribe((value) => log.push(`a=${value}`)),
        b.subscribe((value) => log.push(`b=${value}`)),
        c.subscribe((value) => log.push(`c=${value}`)),
        shifted.subscribe((value) => log.push(`shifted=${value}`)),
      ];
      const sink = (name: string, priority?: number): Node => {
        const update = () => {
          log.push(name);
        };
        const terminal = node({ run: update, priority });
        registerSynchronousSink(terminal, update);
        return terminal;
      };
      const late = sink("late", 3),
        early = sink("early", 1),
        inline = sink("inline");
      scoped(app, () => {
        void c.value;
        void shifted.value;
        reconcileScopedEdges(app, late, [c.node]);
        reconcileScopedEdges(app, early, [b.node]);
        reconcileScopedEdges(app, inline, [a.node]);
        for (const value of [1, 2, 3, 3, 4]) source.value = value;
      });
      const kernelUpdates = update.mock.calls.length;
      update.mockRestore();
      for (const off of offs) off();
      return { log, calls, kernelUpdates };
    });
    expect(inPlace.log).toEqual(kernel.log);
    expect(inPlace.calls).toEqual(kernel.calls);
    expect(kernel.log.length).toBeGreaterThan(10);
    // Only the inspected run went through kernel work items.
    expect(kernel.kernelUpdates).toBeGreaterThan(0);
    expect(inPlace.kernelUpdates).toBe(0);
  });

  it("commits a drain's batch like the kernel: store subscribers, then one graph pass", async () => {
    const [kernel, inPlace] = await bothPaths(async () => {
      const app = scope(),
        left = store(1),
        right = store(2),
        log: string[] = [];
      let evaluations = 0;
      const sum = computed(() => {
        evaluations++;
        return left.value + right.value;
      });
      const product = computed(() => left.value * right.value);
      const offs = [
        left.subscribe((value) => log.push(`left=${value}`)),
        right.subscribe((value) => log.push(`right=${value}`)),
        sum.subscribe((value) => log.push(`sum=${value}`)),
        product.subscribe((value) => log.push(`product=${value}`)),
      ];
      const set = event<number>();
      const writer = reaction({
        on: set,
        run: (value) => {
          left.value = value;
          right.value = value + 1;
        },
      });
      scoped(app, () => void sum.value);
      await scoped(app, () => set(5));
      await scoped(app, () => set(7));
      writer.stop();
      for (const off of offs) off();
      return { log, evaluations };
    });
    expect(inPlace).toEqual(kernel);
  });

  it("commits writes made by subscribers after the update, as the kernel does", async () => {
    const [kernel, inPlace] = await bothPaths(() => {
      const app = scope(),
        source = store(0),
        echo = store(0),
        log: string[] = [];
      const doubled = source.map((value) => value * 2);
      const echoed = echo.map((value) => value + 1000);
      const offs = [
        doubled.subscribe((value) => {
          log.push(`doubled=${value}`);
          echo.value = value;
          log.push(`after write: echoed=${scoped(app, () => echoed.value)}`);
        }),
        echoed.subscribe((value) => log.push(`echoed=${value}`)),
      ];
      scoped(app, () => {
        void echoed.value;
        source.value = 1;
        source.value = 2;
      });
      for (const off of offs) off();
      return log;
    });
    expect(inPlace).toEqual(kernel);
  });

  it("interleaves a drain commit with the writes its store subscribers make", async () => {
    const [kernel, inPlace] = await bothPaths(async () => {
      const app = scope(),
        source = store(0),
        echo = store(0),
        log: string[] = [];
      const s1 = source.map((value) => value + 1),
        s2 = s1.map((value) => value * 10);
      const t1 = echo.map((value) => value + 1),
        t2 = t1.map((value) => value * 10);
      const offs = [
        source.subscribe((value) => {
          log.push(`source=${value}`);
          echo.value = value * 100;
        }),
        ...[s1, s2, t1, t2].map((unit, index) =>
          unit.subscribe((value) => log.push(`${["s1", "s2", "t1", "t2"][index]}=${value}`)),
        ),
      ];
      const set = event<number>();
      const writer = reaction({
        on: set,
        run: (value) => {
          source.value = value;
        },
      });
      scoped(app, () => {
        void s2.value;
        void t2.value;
      });
      await scoped(app, () => set(1));
      await scoped(app, () => set(2));
      writer.stop();
      for (const off of offs) off();
      return log;
    });
    expect(inPlace).toEqual(kernel);
  });

  it("keeps a drain commit's order when one store's graph needs the kernel", async () => {
    const [kernel, inPlace] = await bothPaths(async () => {
      const app = scope(),
        left = store(0),
        right = store(0),
        log: string[] = [];
      const leftDeep = left.map((value) => value + 1).map((value) => value * 2);
      const rightDeep = right.map((value) => value + 1).map((value) => value * 3);
      const offs = [
        leftDeep.subscribe((value) => log.push(`leftDeep=${value}`)),
        rightDeep.subscribe((value) => log.push(`rightDeep=${value}`)),
      ];
      const watcher = reaction({
        scope: app,
        on: left,
        run: (value) => {
          log.push(`reaction=${value}`);
        },
      });
      const set = event<number>();
      const writer = reaction({
        on: set,
        run: (value) => {
          left.value = value;
          right.value = value;
        },
      });
      scoped(app, () => {
        void leftDeep.value;
        void rightDeep.value;
      });
      await scoped(app, () => set(1));
      await scoped(app, () => set(2));
      writer.stop();
      watcher.stop();
      for (const off of offs) off();
      return log;
    });
    expect(inPlace).toEqual(kernel);
  });

  it("keeps the queue order of a commit that mixes custom transaction targets", async () => {
    const [kernel, inPlace] = await bothPaths(async () => {
      const app = scope(),
        value = store(0),
        log: string[] = [];
      const deep = value.map((next) => next + 1).map((next) => next * 2);
      const off = deep.subscribe((next) => log.push(`deep=${next}`));
      const marker = node(() => {
        log.push("custom");
      });
      const custom = {
        id: Symbol("custom"),
        scope: app,
        commit: () => ({
          changed: true,
          notify: () => runDetached({ unit: marker, scope: app }),
        }),
      };
      const set = event<number>();
      const writer = reaction({
        on: set,
        run: (next) => {
          writeTransactionStore(custom, next);
          value.value = next;
        },
      });
      scoped(app, () => void deep.value);
      await scoped(app, () => set(1));
      await scoped(app, () => set(2));
      writer.stop();
      off();
      return log;
    });
    expect(inPlace).toEqual(kernel);
    expect(kernel).toEqual(["custom", "deep=4", "custom", "deep=6"]);
  });

  it("interleaves stores a mixed commit publishes one by one, as the kernel queue does", async () => {
    const [kernel, inPlace] = await bothPaths(async () => {
      const app = scope(),
        left = store(0),
        right = store(0),
        log: string[] = [];
      const units = [left.map((next) => next + 1), right.map((next) => next + 1)];
      units.push(
        units[0].map((next) => next * 2),
        units[1].map((next) => next * 3),
      );
      const offs = units.map((unit, index) =>
        unit.subscribe((next) => log.push(`${index}=${next}`)),
      );
      const custom = {
        id: Symbol("custom"),
        scope: app,
        commit: () => ({ changed: true, notify: () => {} }),
      };
      const set = event<number>();
      const writer = reaction({
        on: set,
        run: (next) => {
          left.value = next;
          writeTransactionStore(custom, next);
          right.value = next;
        },
      });
      scoped(app, () => {
        for (const unit of units) void unit.value;
      });
      await scoped(app, () => set(1));
      writer.stop();
      for (const off of offs) off();
      return log;
    });
    expect(inPlace).toEqual(kernel);
    expect(kernel).toEqual(["0=2", "1=2", "2=4", "3=6"]);
  });

  it("contains a failing computed and fails the awaited trigger whose commit reached it", async () => {
    const reports: string[] = [];
    setErrorReporter((failure) => reports.push(failure.unit));
    try {
      const [kernel, inPlace] = await bothPaths(async () => {
        const app = scope(),
          source = store(0),
          log: string[] = [];
        const failing = computed(
          () => {
            if (source.value === 2) throw new Error("boom");
            return source.value;
          },
          undefined,
          { name: "failing" },
        );
        const healthy = source.map((value) => value * 10);
        const offs = [
          failing.subscribe((value) => log.push(`failing=${value}`)),
          healthy.subscribe((value) => log.push(`healthy=${value}`)),
        ];
        const set = event<number>();
        const writer = reaction({
          on: set,
          run: (value) => {
            source.value = value;
          },
        });
        scoped(app, () => void failing.value);
        await scoped(app, () => set(1));
        let rejected = "";
        await scoped(app, () => set(2)).catch((error: Error) => {
          rejected = error.message;
        });
        scoped(app, () => {
          source.value = 1;
          source.value = 2;
          source.value = 3;
        });
        writer.stop();
        for (const off of offs) off();
        return { log, rejected };
      });
      expect(inPlace).toEqual(kernel);
      expect(kernel.rejected).toBe("boom");
      expect(reports.length).toBe(4);
      expect(reports.slice(0, 2)).toEqual(reports.slice(2));
    } finally {
      setErrorReporter(null);
    }
  });

  it("hands nodes the graph gains mid-update over to the kernel", async () => {
    const [kernel, inPlace] = await bothPaths(() => {
      const app = scope(),
        source = store(0),
        doubled = source.map((value) => value * 2),
        seen: number[] = [];
      let observer: ReturnType<typeof reaction> | undefined;
      const off = doubled.subscribe(() => {
        observer ??= reaction({
          scope: app,
          on: doubled,
          run: (value) => {
            seen.push(value);
          },
        });
      });
      scoped(app, () => {
        void doubled.value;
        source.value = 1;
        source.value = 2;
      });
      observer?.stop();
      off();
      return seen;
    });
    expect(inPlace).toEqual(kernel);
    expect(kernel).toEqual([2, 4]);
  });

  // From the second update on, a computed nobody reads further is not walked
  // on its own: it is an endpoint under its source's entry.
  it("hands over what a remembered leaf gains mid-update", async () => {
    const [kernel, inPlace] = await bothPaths(() => {
      const app = scope(),
        source = store(0),
        doubled = source.map((value) => value * 2),
        seen: number[] = [];
      let observer: ReturnType<typeof reaction> | undefined;
      const off = doubled.subscribe((value) => {
        if (value < 6) return;
        observer ??= reaction({
          scope: app,
          on: doubled,
          run: (next) => {
            seen.push(next);
          },
        });
      });
      scoped(app, () => {
        void doubled.value;
        for (let value = 1; value <= 4; value++) source.value = value;
      });
      observer?.stop();
      off();
      return seen;
    });
    expect(inPlace).toEqual(kernel);
    expect(kernel).toEqual([6, 8]);
  });

  it("reports the path to a remembered leaf that fails", async () => {
    const reports: string[][] = [];
    setErrorReporter((failure) => reports.push(failure.path));
    try {
      const [kernel, inPlace] = await bothPaths(() => {
        const app = scope(),
          source = store(0, undefined, { name: "source" }),
          log: number[] = [];
        const checked = source.map(
          (value) => {
            if (value === 3) throw new Error("boom");
            return value;
          },
          undefined,
        );
        const off = checked.subscribe((value) => log.push(value));
        scoped(app, () => {
          void checked.value;
          for (let value = 1; value <= 4; value++) source.value = value;
        });
        off();
        return log;
      });
      expect(inPlace).toEqual(kernel);
      expect(kernel).toEqual([1, 2, 4]);
      expect(reports.length).toBe(2);
      expect(reports[1]).toEqual(reports[0]);
      expect(reports[0][0]).toContain("source");
    } finally {
      setErrorReporter(null);
    }
  });

  it("keeps the kernel path for a store whose runner was replaced", () => {
    const app = scope(),
      source = store(0),
      doubled = source.map((value) => value * 2),
      seen: number[] = [];
    const nodeOf = source.node as Node;
    const original = nodeOf.run!;
    let runs = 0;
    nodeOf.run = (ctx) => {
      runs++;
      return original.call(nodeOf, ctx);
    };
    const off = doubled.subscribe((value) => seen.push(value));
    try {
      scoped(app, () => {
        void doubled.value;
        source.value = 1;
      });
      expect(runs).toBe(1);
      expect(seen).toEqual([2]);
    } finally {
      nodeOf.run = original;
      off();
    }
  });
});
