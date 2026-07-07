import { describe, expect, it } from "vitest";
import {
  effect,
  event,
  lazyModel,
  reaction,
  scope,
  scoped,
  store,
  type Effect,
  type EventCallable,
  type StoreWritable,
} from "../lib";

interface CounterModel {
  count: StoreWritable<number>;
  incremented: EventCallable<number>;
}

describe("lazyModel", () => {
  it("exposes scoped pending store while the model is loading", async () => {
    const appScope = scope();
    let resolveModel!: (model: CounterModel) => void;
    const loaded = new Promise<CounterModel>((resolve) => {
      resolveModel = resolve;
    });
    const model = lazyModel<CounterModel>(() => loaded);

    scoped(appScope, () => {
      expect(model.pending.value).toBe(false);
    });

    const loading = scoped(appScope, () => model.incremented(2));

    await waitForMicrotask();

    scoped(appScope, () => {
      expect(model.pending.value).toBe(true);
    });

    const incremented = event<number>();
    const count = store(0);

    reaction({
      on: incremented,
      run(amount: number) {
        count.value += amount;
      },
    });

    resolveModel({ count, incremented });
    await loading;

    scoped(appScope, () => {
      expect(model.pending.value).toBe(false);
      expect(model.count.value).toBe(2);
    });
  });

  it("loads a model when a lazy unit is launched and forwards payload", async () => {
    const appScope = scope();
    let loads = 0;
    const model = lazyModel<CounterModel>(async () => {
      loads += 1;
      const incremented = event<number>();
      const count = store(0);

      reaction({
        on: incremented,
        run(amount: number) {
          count.value += amount;
        },
      });

      return { count, incremented };
    });

    const incremented = model.incremented;
    const count = model.count;

    expect(loads).toBe(0);

    await scoped(appScope, () => incremented(2));

    expect(loads).toBe(1);
    scoped(appScope, () => {
      expect(count.value).toBe(2);
      expect(Reflect.ownKeys(count)).toContain("value");
      expect(Reflect.ownKeys(count)).not.toContain("prototype");
    });

    await scoped(appScope, () => model.incremented(3));

    expect(loads).toBe(1);
    scoped(appScope, () => {
      expect(model.count.value).toBe(5);
    });
  });

  it("runs reactions attached to a lazy event before the model is loaded", async () => {
    const appScope = scope();
    const received: number[] = [];
    const model = lazyModel<CounterModel>(async () => {
      const incremented = event<number>();
      const count = store(0);

      reaction({
        on: incremented,
        run(amount: number) {
          count.value += amount;
        },
      });

      return { count, incremented };
    });

    reaction({
      on: model.incremented,
      run(amount: number) {
        received.push(amount);
      },
    });

    await scoped(appScope, () => model.incremented(10));

    expect(received).toEqual([10]);

    await scoped(appScope, () => model.incremented(11));

    expect(received).toEqual([10, 11]);
  });

  it("runs reactions attached to lazy effect lifecycle units before the model is loaded", async () => {
    const appScope = scope();
    const received: string[] = [];
    const model = lazyModel<{ loadFx: Effect<number, string, Error> }>(async () => ({
      loadFx: effect(async (id: number) => `user:${id}`),
    }));

    reaction({
      on: model.loadFx.doneData,
      run(value: string) {
        received.push(value);
      },
    });

    await scoped(appScope, () => model.loadFx(7));

    expect(received).toEqual(["user:7"]);
  });

  it("calls a lazy effect directly inside a scope", async () => {
    const appScope = scope();
    let loads = 0;
    const model = lazyModel<{ doubleFx: Effect<number, number> }>(async () => {
      loads += 1;

      return {
        doubleFx: effect(async (value: number) => value * 2),
      };
    });

    const result = await scoped(appScope, () => model.doubleFx(4));

    expect(result).toBe(8);
    expect(loads).toBe(1);
  });

  it("keeps store reads synchronous before the model is loaded", () => {
    const appScope = scope();
    const model = lazyModel<CounterModel>(async () => ({
      count: store(0),
      incremented: event<number>(),
    }));

    expect(() => {
      scoped(appScope, () => model.count.value);
    }).toThrow("Lazy unit is not loaded yet");
  });
});

function waitForMicrotask(): Promise<void> {
  return Promise.resolve();
}
