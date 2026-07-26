import { describe, expect, it } from "vitest";
import { effect, event, getCurrentScope, reaction, scope, scoped, store } from "../../lib";
import { flush, never, waitForMicrotask } from "../support/async-flush";

describe("effect", () => {
  it("replaces the default handler with a scope override", async () => {
    const doubleFx = effect((value: number) => value * 2);
    const plainScope = scope();
    const overrideScope = scope({ handlers: [[doubleFx, (value) => value * 10]] });

    await expect(scoped(plainScope, () => doubleFx(2))).resolves.toBe(4);
    await expect(scoped(overrideScope, () => doubleFx(2))).resolves.toBe(20);
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
    it("fires the base lifecycle for an identity variant with a config key", async () => {
      const appScope = scope();
      const requestFx = effect(async (params: { id: number }) => `item:${params.id}`);
      const variantFx = requestFx.variant({ name: "variantFx", key: true });
      const fired: unknown[] = [];

      reaction({ on: requestFx.doneData, run: (value) => fired.push(["base", value]) });
      reaction({ on: variantFx.doneData, run: (value) => fired.push(["variant", value]) });

      await expect(scoped(appScope, () => variantFx({ id: 7 }))).resolves.toBe("item:7");

      // The base settles first: the variant is waiting on the base call it made,
      // so its own done cannot fire before the base's.
      expect(fired).toEqual([
        ["base", "item:7"],
        ["variant", "item:7"],
      ]);
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
      // Every link in the chain is a real call, so the root base settles too.
      expect(fired).toEqual([
        ["base", "root:5"],
        ["v2", "root:5"],
      ]);
    });

    it("replaces its delegating handler with a scope override on the variant itself", async () => {
      const baseFx = effect((value: number) => `base:${value}`);
      const variantFx = baseFx.variant("variantFx");
      const appScope = scope({ handlers: [[variantFx, (value: number) => `mock:${value}`]] });
      const fired: unknown[] = [];

      reaction({ on: baseFx.doneData, run: (value) => fired.push(["base", value]) });
      reaction({ on: variantFx.doneData, run: (value) => fired.push(["variant", value]) });

      await expect(scoped(appScope, () => variantFx(2))).resolves.toBe("mock:2");
      // The override replaces the delegating handler itself, so the base is never
      // called — the one path on which its lifecycle stays silent.
      expect(fired).toEqual([["variant", "mock:2"]]);
    });

    it("cancels the base call when the variant is aborted", async () => {
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
      // The base call was created while the variant's call was current, so it
      // inherited that signal and aborts with the same reason — under its own
      // (mapped) params.
      expect(seen).toEqual([
        ["base", { params: 4, reason }],
        ["variant", { params: "4", reason }],
      ]);
    });

    it("fires the base lifecycle units alongside its own", async () => {
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

      expect(values).toEqual([
        ["base", "item:7"],
        ["variant", "item:7"],
      ]);
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

    it("aborts a param-mapping variant together with the base", async () => {
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
      expect(values).toEqual([
        ["base", { params: 4, reason }],
        ["variant", { params: "4", reason }],
      ]);
    });

    it("starts the base with the variant's mapped params", async () => {
      const appScope = scope();
      const requestFx = effect(async (params: { id: number }) => `item:${params.id}`);
      const variantFx = requestFx.variant("variantFx", (id: number) => ({ id }));
      const started: unknown[] = [];

      reaction({ on: requestFx.started, run: (params) => started.push(["base", params]) });
      reaction({ on: variantFx.started, run: (params) => started.push(["variant", params]) });

      await scoped(appScope, () => variantFx(7));

      // The variant starts first and only then calls the base, which sees the
      // params the mapper produced.
      expect(started).toEqual([
        ["variant", 7],
        ["base", { id: 7 }],
      ]);
    });

    it("counts calls made through every variant in the base's inFlight", async () => {
      const appScope = scope();
      const releases: Array<(value: string) => void> = [];
      const requestFx = effect<number, string, unknown>(
        () =>
          new Promise<string>((resolve) => {
            releases.push(resolve);
          }),
      );
      const firstFx = requestFx.variant("firstFx");
      const secondFx = requestFx.variant("secondFx");

      const calls = scoped(appScope, () => Promise.all([firstFx(1), secondFx(2)]));
      await flush();

      scoped(appScope, () => {
        // Two variant calls, one shared base counter: this aggregation is the
        // whole point of routing through the base effect.
        expect(requestFx.pending.value).toBe(true);
        expect(requestFx.inFlight.value).toBe(2);
        expect(firstFx.inFlight.value).toBe(1);
        expect(secondFx.inFlight.value).toBe(1);
      });

      for (const release of releases) release("done");
      await calls;

      scoped(appScope, () => {
        expect(requestFx.pending.value).toBe(false);
        expect(requestFx.inFlight.value).toBe(0);
      });
    });

    it("surfaces a failing base call through the variant's fail channel", async () => {
      const appScope = scope();
      const boom = new Error("boom");
      const requestFx = effect<number, number, Error>(async () => {
        throw boom;
      });
      const variantFx = requestFx.variant("variantFx");
      const fails: unknown[] = [];

      reaction({ on: requestFx.failData, run: (value) => fails.push(["base", value]) });
      reaction({ on: variantFx.failData, run: (value) => fails.push(["variant", value]) });

      await expect(scoped(appScope, () => variantFx(1))).rejects.toBe(boom);
      expect(fails).toEqual([
        ["base", boom],
        ["variant", boom],
      ]);
    });
  });
});
