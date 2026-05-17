import { describe, expect, it } from "vitest";
import { effect, event, reaction, scope, scoped, store } from "../lib";

describe("effect", () => {
  it("returns handler result and emits success units", async () => {
    const appScope = scope();
    const doubleFx = effect(async (value: number) => value * 2);
    const values: unknown[] = [];

    reaction({
      on: doubleFx.started,
      run: (value: number) => {
        values.push(["started", value]);
      },
    });
    reaction({
      on: doubleFx.done,
      run: (value: { params: number; result: number }) => {
        values.push(["done", value]);
      },
    });
    reaction({
      on: doubleFx.doneData,
      run: (value: number) => {
        values.push(["doneData", value]);
      },
    });
    reaction({
      on: doubleFx.finally,
      run: (value: unknown) => {
        values.push(["finally", value]);
      },
    });

    const result = await scoped(appScope, () => doubleFx(3));

    expect(result).toBe(6);
    expect(values).toEqual([
      ["started", 3],
      ["done", { params: 3, result: 6 }],
      ["doneData", 6],
      ["finally", { status: "done", params: 3, result: 6 }],
    ]);
    scoped(appScope, () => {
      expect(doubleFx.$pending.value).toBe(false);
      expect(doubleFx.$inFlight.value).toBe(0);
    });
  });

  it("rejects with handler error and emits failure units", async () => {
    const appScope = scope();
    const error = new Error("boom");
    const failFx = effect<number, string, Error>(() => {
      throw error;
    });
    const values: unknown[] = [];

    reaction({
      on: failFx.failed,
      run: (value: { params: number; error: Error }) => {
        values.push(["failed", value]);
      },
    });
    reaction({
      on: failFx.failData,
      run: (value: Error) => {
        values.push(["failData", value]);
      },
    });
    reaction({
      on: failFx.settled,
      run: (value: unknown) => {
        values.push(["settled", value]);
      },
    });

    const promise = scoped(appScope, () => failFx(3));

    await expect(promise).rejects.toBe(error);
    expect(values).toEqual([
      ["failed", { params: 3, error }],
      ["failData", error],
      ["settled", { status: "fail", params: 3, error }],
    ]);
    scoped(appScope, () => {
      expect(failFx.$pending.value).toBe(false);
      expect(failFx.$inFlight.value).toBe(0);
    });
  });

  it("aborts active calls and emits aborted", async () => {
    const appScope = scope();
    const reason = new Error("stop");
    const waitFx = effect<void, string, Error>(
      (_, { signal }) =>
        new Promise((resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              reject(signal.reason);
            },
            { once: true },
          );

          if (signal.aborted) {
            reject(signal.reason);
          }
        }),
    );
    const values: unknown[] = [];

    reaction({
      on: waitFx.aborted,
      run: (value: unknown) => {
        values.push(["aborted", value]);
      },
    });
    reaction({
      on: waitFx.failData,
      run: (value: Error) => {
        values.push(["failData", value]);
      },
    });

    const promise = scoped(appScope, () => waitFx());
    await waitForMicrotask();
    await waitFx.abort(reason);

    await expect(promise).rejects.toBe(reason);
    expect(values).toEqual([
      ["aborted", { params: undefined, reason }],
      ["failData", reason],
    ]);
    scoped(appScope, () => {
      expect(waitFx.$pending.value).toBe(false);
      expect(waitFx.$inFlight.value).toBe(0);
    });
  });

  it("publishes lifecycle stores immediately when an async effect starts inside a transaction", async () => {
    const appScope = scope();
    const submitted = event();
    const value = store(0);
    let resolveFx!: (value: string) => void;
    const saveFx = effect(
      () =>
        new Promise<string>((resolve) => {
          resolveFx = resolve;
        }),
    );
    const pendingValues: boolean[] = [];

    saveFx.$pending.subscribe((next) => {
      pendingValues.push(next);
    });
    reaction({
      on: submitted,
      run() {
        value.value = 1;
        void saveFx();
      },
    });

    const promise = scoped(appScope, () => submitted());
    await waitForMicrotask();

    expect(pendingValues).toEqual([true]);
    scoped(appScope, () => {
      expect(value.value).toBe(1);
      expect(saveFx.$pending.value).toBe(true);
      expect(saveFx.$inFlight.value).toBe(1);
    });

    resolveFx("ok");
    await promise;

    expect(pendingValues).toEqual([true, false]);
    scoped(appScope, () => {
      expect(saveFx.$pending.value).toBe(false);
      expect(saveFx.$inFlight.value).toBe(0);
    });
  });

  it("uses effect handlers from the current scope", async () => {
    const doubleFx = effect((value: number) => value * 2);
    const firstScope = scope();
    const secondScope = scope({
      handlers: [[doubleFx, (value) => value * 10]],
    });

    await expect(scoped(firstScope, () => doubleFx(2))).resolves.toBe(4);
    await expect(scoped(secondScope, () => doubleFx(2))).resolves.toBe(20);
  });
});

function waitForMicrotask(): Promise<void> {
  return Promise.resolve();
}
