import { describe, expect, it } from "vitest";
import { getOwner, onCleanup, owner, reaction, run, scope, store, withOwner, scoped } from "../lib";

describe("reaction", () => {
  it("runs immediately in auto mode and tracks stores read during execution", async () => {
    const appScope = scope();
    const counter = store(1);
    const values: number[] = [];

    reaction(() => {
      values.push(counter.value);
    });

    await run({ unit: counter.node, payload: 2, scope: appScope });

    expect(values).toEqual([1, 2]);
  });

  it("registers auto reactions without an active scope", async () => {
    const appScope = scope();
    const counter = store(1);
    const values: number[] = [];

    reaction(() => {
      values.push(counter.value);
    });

    await run({ unit: counter.node, payload: 2, scope: appScope });

    expect(values).toEqual([1, 2]);
  });

  it("tracks auto reaction dependencies without requiring scoped derived writes", async () => {
    const appScope = scope();
    const counter = store(1);
    const doubled = store(0);

    reaction(() => {
      doubled.value = counter.value * 2;
    });

    await run({ unit: counter.node, payload: 3, scope: appScope });

    scoped(appScope, () => {
      expect(doubled.value).toBe(6);
    });
  });

  it("updates auto dependencies when the read branch changes", async () => {
    const appScope = scope();
    const useLeft = store(true);
    const left = store(1);
    const right = store(10);
    const values: number[] = [];

    reaction(() => {
      values.push(useLeft.value ? left.value : right.value);
    });

    await run({ unit: right.node, payload: 11, scope: appScope });
    await run({ unit: left.node, payload: 2, scope: appScope });
    await run({ unit: useLeft.node, payload: false, scope: appScope });
    await run({ unit: left.node, payload: 3, scope: appScope });
    await run({ unit: right.node, payload: 12, scope: appScope });

    expect(values).toEqual([1, 2, 11, 12]);
  });

  it("stops explicit reactions", async () => {
    const appScope = scope();
    const counter = store(0);
    const values: number[] = [];
    const subscription = reaction({
      on: counter,
      run: (value: number) => {
        values.push(value);
      },
    });

    await run({ unit: counter.node, payload: 1, scope: appScope });
    subscription.stop();
    await run({ unit: counter.node, payload: 2, scope: appScope });

    expect(values).toEqual([1]);
    expect(subscription.dependencies()).toEqual([]);
  });

  it("can be limited to a scope", async () => {
    const firstScope = scope();
    const secondScope = scope();
    const counter = store(0);
    const values: number[] = [];

    reaction({
      on: counter,
      scope: secondScope,
      run: (value: number) => {
        values.push(value);
      },
    });

    await run({ unit: counter.node, payload: 1, scope: firstScope });
    await run({ unit: counter.node, payload: 2, scope: secondScope });

    expect(values).toEqual([2]);
  });

  it("runs auto reactions in the configured scope", async () => {
    const firstScope = scope();
    const secondScope = scope();
    const counter = store(0);
    const values: number[] = [];

    scoped(secondScope, () => {
      counter.value = 10;
    });

    reaction({
      scope: secondScope,
      run: () => {
        values.push(counter.value);
      },
    });

    await run({ unit: counter.node, payload: 1, scope: firstScope });
    await run({ unit: counter.node, payload: 11, scope: secondScope });

    expect(values).toEqual([10, 11]);
  });
});

describe("owner", () => {
  it("runs cleanups on dispose and detaches owned graph work", async () => {
    const appScope = scope();
    const source = store(1);
    const values: unknown[] = [];
    const model = owner((dispose) => {
      onCleanup(() => {
        values.push("disposed");
      });

      const doubled = source.map((value) => value * 2);

      reaction({
        on: doubled,
        run: (value: number) => {
          values.push(["reaction", value]);
        },
      });

      source.subscribe((value) => {
        values.push(["subscription", value]);
      });

      return { dispose };
    });

    await run({ unit: source.node, payload: 2, scope: appScope });
    model.dispose();
    await run({ unit: source.node, payload: 3, scope: appScope });

    expect(values).toEqual([["subscription", 2], ["reaction", 4], "disposed"]);
  });

  it("supports explicit owner reuse with withOwner", () => {
    const values: string[] = [];

    const model = owner((dispose, owner) => {
      return { dispose, owner };
    });

    withOwner(model.owner, () => {
      expect(getOwner()).toBe(model.owner);
      onCleanup(() => {
        values.push("cleanup");
      });
    });

    expect(getOwner()).toBeNull();

    model.dispose();

    expect(values).toEqual(["cleanup"]);
  });

  it("runs cleanup immediately when it is registered into a disposed owner", () => {
    const values: string[] = [];
    const model = owner((dispose, owner) => ({ dispose, owner }));

    model.dispose();
    withOwner(model.owner, () => {
      onCleanup(() => {
        values.push("late-cleanup");
      });
    });

    expect(values).toEqual(["late-cleanup"]);
  });

  it("adds disposable methods to the returned model root", () => {
    const values: string[] = [];
    const model = owner(() => {
      onCleanup(() => {
        values.push("cleanup");
      });

      return { value: 1 };
    });

    expect(typeof model.dispose).toBe("function");
    expect(typeof model[Symbol.dispose]).toBe("function");
    expect(Object.keys(model)).toEqual(["value"]);

    model[Symbol.dispose]();
    model.dispose();

    expect(values).toEqual(["cleanup"]);
  });
});
