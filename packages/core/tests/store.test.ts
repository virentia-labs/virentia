import { describe, expect, it } from "vitest";
import { reaction, reactive, run, scope, store, scoped } from "../lib";

describe("store", () => {
  it("keeps proxy state isolated per scope", () => {
    const firstScope = scope();
    const secondScope = scope();
    const counter = store(0);

    scoped(firstScope, () => {
      counter.value = 1;
    });

    scoped(secondScope, () => {
      counter.value = 2;
    });

    scoped(firstScope, () => {
      expect(counter.value).toBe(1);
    });
    scoped(secondScope, () => {
      expect(counter.value).toBe(2);
    });
    expect(() => counter.value).toThrow("Scope is required");
  });

  it("writes object stores through regular property assignment", () => {
    const appScope = scope();
    const user = reactive({ name: "Ada", age: 36 });
    const values: unknown[] = [];
    user.subscribe((value) => {
      values.push(value);
    });

    scoped(appScope, () => {
      user.age = 37;
    });

    scoped(appScope, () => {
      expect(user.name).toBe("Ada");
      expect(user.age).toBe(37);
    });
    expect(values).toEqual([{ name: "Ada", age: 37 }]);
  });

  it("rejects invalid proxy writes", () => {
    const appScope = scope();
    const counter = store(0);
    const doubled = counter.map((value) => value * 2);

    const writeNonValueProperty = () => {
      scoped(appScope, () => {
        (counter as unknown as { count: number }).count = 1;
      });
    };
    const writeReadonlyStore = () => {
      scoped(appScope, () => {
        (doubled as unknown as { value: number }).value = 10;
      });
    };

    expect(writeNonValueProperty).toThrow("Store value must be written through .value");
    expect(writeReadonlyStore).toThrow("Store is read-only");
  });

  it("does not commit skipped values", async () => {
    const appScope = scope();
    const counter = store(1, -1);
    const values: number[] = [];
    counter.subscribe((value) => {
      values.push(value);
    });

    await run({ unit: counter.node, payload: -1, scope: appScope });
    scoped(appScope, () => {
      counter.value = -1;
    });

    scoped(appScope, () => {
      expect(counter.value).toBe(1);
    });
    expect(values).toEqual([]);
  });

  it("does not notify subscribers after unsubscribe", async () => {
    const appScope = scope();
    const counter = store(0);
    const values: number[] = [];
    const unsubscribe = counter.subscribe((value) => {
      values.push(value);
    });

    await run({ unit: counter.node, payload: 1, scope: appScope });
    unsubscribe();
    await run({ unit: counter.node, payload: 2, scope: appScope });

    expect(values).toEqual([1]);
  });

  it("derives stores with map, filter, and filterMap", async () => {
    const appScope = scope();
    const source = store(1);
    const doubled = source.map((value) => value * 2);
    const even = source.filter((value) => value % 2 === 0);
    const label = source.filterMap((value) => (value > 2 ? `#${value}` : "skip"), "skip");
    const values: unknown[] = [];

    reaction({
      on: doubled,
      run: (value: number) => {
        values.push(["doubled", value]);
      },
    });
    reaction({
      on: even,
      run: (value: number) => {
        values.push(["even", value]);
      },
    });
    reaction({
      on: label,
      run: (value: string) => {
        values.push(["label", value]);
      },
    });

    await run({ unit: source.node, payload: 2, scope: appScope });
    await run({ unit: source.node, payload: 3, scope: appScope });

    expect(values).toEqual([
      ["doubled", 4],
      ["even", 2],
      ["doubled", 6],
      ["label", "#3"],
    ]);
  });
});
