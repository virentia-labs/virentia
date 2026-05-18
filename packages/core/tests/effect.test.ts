import { describe, expect, expectTypeOf, it } from "vitest";
import { effect, event, reaction, scope, scoped, store } from "../lib";
import type { EffectParams } from "../lib";

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
    const waitFx = effect<string, Error>(() => new Promise<string>(() => {}));
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

  it("cascades abort to effects called by an active effect", async () => {
    const appScope = scope();
    const reason = new Error("stop tree");
    const values: unknown[] = [];
    const leafFx = effect<string, Error>(() => new Promise<string>(() => {}));
    const middleFx = effect(() => leafFx());
    const rootFx = effect(() => middleFx());

    reaction({
      on: rootFx.aborted,
      run(value) {
        values.push(["root", value]);
      },
    });
    reaction({
      on: middleFx.aborted,
      run(value) {
        values.push(["middle", value]);
      },
    });
    reaction({
      on: leafFx.aborted,
      run(value) {
        values.push(["leaf", value]);
      },
    });

    const promise = scoped(appScope, () => rootFx());
    await waitForMicrotask();
    await rootFx.abort(reason);

    await expect(promise).rejects.toBe(reason);
    expect(values).toEqual(
      expect.arrayContaining([
        ["root", { params: undefined, reason }],
        ["middle", { params: undefined, reason }],
        ["leaf", { params: undefined, reason }],
      ]),
    );
    scoped(appScope, () => {
      expect(rootFx.$pending.value).toBe(false);
      expect(rootFx.$inFlight.value).toBe(0);
      expect(middleFx.$pending.value).toBe(false);
      expect(middleFx.$inFlight.value).toBe(0);
      expect(leafFx.$pending.value).toBe(false);
      expect(leafFx.$inFlight.value).toBe(0);
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

  it("creates identity variants with independent lifecycle units", async () => {
    const appScope = scope();
    const requestFx = effect(async (params: { id: number }) => `item:${params.id}`);
    const profileRequestFx = requestFx.variant("profileRequestFx");
    const values: unknown[] = [];

    expectTypeOf<EffectParams<typeof profileRequestFx>>().toEqualTypeOf<{ id: number }>();

    reaction({
      on: requestFx.doneData,
      run(value) {
        values.push(["base", value]);
      },
    });
    reaction({
      on: profileRequestFx.doneData,
      run(value) {
        values.push(["variant", value]);
      },
    });

    await expect(scoped(appScope, () => profileRequestFx({ id: 7 }))).resolves.toBe("item:7");

    expect(values).toEqual([["variant", "item:7"]]);
    scoped(appScope, () => {
      expect(requestFx.$pending.value).toBe(false);
      expect(requestFx.$inFlight.value).toBe(0);
      expect(profileRequestFx.$pending.value).toBe(false);
      expect(profileRequestFx.$inFlight.value).toBe(0);
    });
  });

  it("maps variant params in the current scope and reuses scoped base handlers", async () => {
    const token = store("root-token");
    const requestFx = effect((params: { id: number; token: string }) => {
      return `real:${params.id}:${params.token}`;
    });
    const authorizedRequestFx = requestFx.variant("authorizedRequestFx", (id: number) => ({
      id,
      token: token.value,
    }));
    const configuredRequestFx = requestFx.variant({
      name: "configuredRequestFx",
      params(id: string) {
        return {
          id: Number(id),
          token: token.value,
        };
      },
    });
    const appScope = scope({
      values: [[token, "scope-token"]],
      handlers: [
        [
          requestFx,
          (params: { id: number; token: string }) => `mock:${params.id}:${params.token}`,
        ],
      ],
    });

    expectTypeOf<EffectParams<typeof authorizedRequestFx>>().toEqualTypeOf<number>();
    expectTypeOf<EffectParams<typeof configuredRequestFx>>().toEqualTypeOf<string>();

    await expect(scoped(appScope, () => authorizedRequestFx(3))).resolves.toBe(
      "mock:3:scope-token",
    );
    await expect(scoped(appScope, () => configuredRequestFx("4"))).resolves.toBe(
      "mock:4:scope-token",
    );
  });

  it("keeps abort lifecycle on a variant separate from the base effect", async () => {
    const appScope = scope();
    const reason = new Error("cancel variant");
    const requestFx = effect<number, string, Error>(
      (_params, { signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              reject(signal.reason);
            },
            { once: true },
          );
        }),
    );
    const variantFx = requestFx.variant("variantFx", (value: string) => Number(value));
    const values: unknown[] = [];

    reaction({
      on: requestFx.aborted,
      run(value) {
        values.push(["base", value]);
      },
    });
    reaction({
      on: variantFx.aborted,
      run(value) {
        values.push(["variant", value]);
      },
    });

    const promise = scoped(appScope, () => variantFx("4"));
    await waitForMicrotask();
    await variantFx.abort(reason);

    await expect(promise).rejects.toBe(reason);
    expect(values).toEqual([["variant", { params: "4", reason }]]);
  });
});

function waitForMicrotask(): Promise<void> {
  return Promise.resolve();
}
