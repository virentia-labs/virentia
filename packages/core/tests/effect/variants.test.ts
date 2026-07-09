import { describe, expect, it } from "vitest";
import { effect, event, getCurrentScope, reaction, scope, scoped, store } from "../../lib";
import { runEffectHandler } from "../../lib/units/effect";
import { flush, never, waitForMicrotask } from "../support/async-flush";

describe("effect", () => {
  it("replaces the default handler with a scope override", async () => {
    const doubleFx = effect((value: number) => value * 2);
    const plainScope = scope();
    const overrideScope = scope({ handlers: [[doubleFx, (value) => value * 10]] });

    await expect(scoped(plainScope, () => doubleFx(2))).resolves.toBe(4);
    await expect(scoped(overrideScope, () => doubleFx(2))).resolves.toBe(20);
  });

  it("prefers a scope override over the effect handler in runEffectHandler", () => {
    const fx = effect((value: number) => value * 2);
    const plainScope = scope();
    const overrideScope = scope({ handlers: [[fx, (value) => value * 100]] });
    const ctxBase = { signal: new AbortController().signal };

    expect(runEffectHandler(fx, 3, { ...ctxBase, scope: plainScope })).toBe(6);
    expect(runEffectHandler(fx, 3, { ...ctxBase, scope: overrideScope })).toBe(300);
  });

  it("runs the handler provided by the current scope", async () => {
    const doubleFx = effect((value: number) => value * 2);
    const firstScope = scope();
    const secondScope = scope({
      handlers: [[doubleFx, (value) => value * 10]],
    });

    await expect(scoped(firstScope, () => doubleFx(2))).resolves.toBe(4);
    await expect(scoped(secondScope, () => doubleFx(2))).resolves.toBe(20);
  });

  it("aliases fail to failed and finally to settled by reference", () => {
    const fx = effect(async (value: number) => value);

    expect(fx.fail).toBe(fx.failed);
    expect(fx.finally).toBe(fx.settled);
  });

  it("keeps the scope installed across an awaited call in a scoped body", async () => {
    const appScope = scope();
    const target = store(0);
    const fx = effect(async (value: number) => value + 1);

    const returnedScope = await scoped(appScope, async () => {
      const result = await fx(2);
      target.value = result;
      return getCurrentScope();
    });

    expect(returnedScope).toBe(appScope);
    expect(scoped(appScope, () => target.value)).toBe(3);
  });

  it("waits inside scoped for an async effect fired from a reaction", async () => {
    const appScope = scope();
    const trigger = event<void>();
    const fx = effect(async () => "loaded");
    const recorded: string[] = [];

    reaction({
      on: trigger,
      run: () => {
        void fx();
      },
    });
    reaction({ on: fx.doneData, run: (value) => recorded.push(value) });

    await scoped(appScope, () => trigger());

    // The spawned effect already settled before scoped resolved.
    expect(recorded).toEqual(["loaded"]);
  });

  describe("a variant", () => {
    it("does not fire base lifecycle for an identity variant with a config key", async () => {
      const appScope = scope();
      const requestFx = effect(async (params: { id: number }) => `item:${params.id}`);
      const variantFx = requestFx.variant({ name: "variantFx", key: true });
      const fired: unknown[] = [];

      reaction({ on: requestFx.doneData, run: (value) => fired.push(["base", value]) });
      reaction({ on: variantFx.doneData, run: (value) => fired.push(["variant", value]) });

      await expect(scoped(appScope, () => variantFx({ id: 7 }))).resolves.toBe("item:7");

      expect(fired).toEqual([["variant", "item:7"]]);
      scoped(appScope, () => {
        expect(requestFx.pending.value).toBe(false);
        expect(requestFx.inFlight.value).toBe(0);
        expect(variantFx.pending.value).toBe(false);
        expect(variantFx.inFlight.value).toBe(0);
      });
    });

    it("delegates a variant of a variant to the root base honoring a scope override", async () => {
      const baseFx = effect((value: number) => `base:${value}`);
      const v1 = baseFx.variant((text: string) => Number(text));
      const v2 = v1.variant((value: number) => String(value));
      const appScope = scope({ handlers: [[baseFx, (value: number) => `root:${value}`]] });
      const fired: unknown[] = [];

      reaction({ on: baseFx.doneData, run: (value) => fired.push(["base", value]) });
      reaction({ on: v2.doneData, run: (value) => fired.push(["v2", value]) });

      // v2(5) -> String(5)="5" -> Number("5")=5 -> root override -> "root:5"
      await expect(scoped(appScope, () => v2(5))).resolves.toBe("root:5");
      expect(fired).toEqual([["v2", "root:5"]]);
    });

    it("replaces its delegating handler with a scope override on the variant itself", async () => {
      const baseFx = effect((value: number) => `base:${value}`);
      const variantFx = baseFx.variant("variantFx");
      const appScope = scope({ handlers: [[variantFx, (value: number) => `mock:${value}`]] });
      const fired: unknown[] = [];

      reaction({ on: baseFx.doneData, run: (value) => fired.push(["base", value]) });
      reaction({ on: variantFx.doneData, run: (value) => fired.push(["variant", value]) });

      await expect(scoped(appScope, () => variantFx(2))).resolves.toBe("mock:2");
      expect(fired).toEqual([["variant", "mock:2"]]);
    });

    it("keeps its abort lifecycle independent of the base", async () => {
      const appScope = scope();
      const reason = new Error("variant cancel");
      const baseFx = effect<number, string, unknown>(() => never<string>());
      const variantFx = baseFx.variant("variantFx", (text: string) => Number(text));
      const seen: unknown[] = [];

      reaction({ on: baseFx.aborted, run: (value) => seen.push(["base", value]) });
      reaction({ on: variantFx.aborted, run: (value) => seen.push(["variant", value]) });

      const call = scoped(appScope, () => variantFx("4"));
      await flush();
      await scoped(appScope, () => variantFx.abort(reason));

      await expect(call).rejects.toBe(reason);
      expect(seen).toEqual([["variant", { params: "4", reason }]]);
    });

    it("fires only its own lifecycle units, leaving the base silent", async () => {
      const appScope = scope();
      const requestFx = effect(async (params: { id: number }) => `item:${params.id}`);
      const profileRequestFx = requestFx.variant("profileRequestFx");
      const values: unknown[] = [];

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
        expect(requestFx.pending.value).toBe(false);
        expect(requestFx.inFlight.value).toBe(0);
        expect(profileRequestFx.pending.value).toBe(false);
        expect(profileRequestFx.inFlight.value).toBe(0);
      });
    });

    it("maps its params in the current scope through the scoped base handler", async () => {
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
          [requestFx, (params: { id: number; token: string }) => `mock:${params.id}:${params.token}`],
        ],
      });

      await expect(scoped(appScope, () => authorizedRequestFx(3))).resolves.toBe(
        "mock:3:scope-token",
      );
      await expect(scoped(appScope, () => configuredRequestFx("4"))).resolves.toBe(
        "mock:4:scope-token",
      );
    });

    it("aborts a param-mapping variant without touching the base", async () => {
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
});
