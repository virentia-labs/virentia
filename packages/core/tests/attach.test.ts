import { describe, expect, it } from "vitest";
import { attach, effect, reaction, scope, scoped, store } from "../lib";

describe("attach", () => {
  it("reads source stores in the current scope", async () => {
    const appScope = scope();
    const token = store("root");
    const requestFx = effect(async (params: { id: number; token: string }) => {
      return `${params.token}:${params.id}`;
    });
    const authorizedFx = attach({
      source: token,
      effect: requestFx,
      mapParams: (id: number, token: string) => ({ id, token }),
    });

    scoped(appScope, () => {
      token.value = "scoped";
    });

    const result = await scoped(appScope, () => authorizedFx(42));

    expect(result).toBe("scoped:42");
    scoped(appScope, () => {
      expect(authorizedFx.$pending.value).toBe(false);
      expect(requestFx.$pending.value).toBe(false);
    });
  });

  it("passes object source to inline handlers", async () => {
    const appScope = scope();
    const token = store("root");
    const locale = store("en");
    const requestFx = attach({
      source: { locale, token },
      effect: (source: { locale: string; token: string }, id: number) => {
        return `${source.locale}:${source.token}:${id}`;
      },
    });

    scoped(appScope, () => {
      token.value = "scoped";
      locale.value = "ru";
    });

    await expect(scoped(appScope, () => requestFx(7))).resolves.toBe("ru:scoped:7");
  });

  it("propagates abort signal to the base effect", async () => {
    const appScope = scope();
    const reason = new Error("stop");
    const waitFx = effect<string, string, Error>(
      (_value, { signal }) =>
        new Promise((_resolve, reject) => {
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
    const attachedFx = attach({
      effect: waitFx,
      mapParams: (id: number) => String(id),
    });
    const aborted: unknown[] = [];

    reaction({
      on: attachedFx.aborted,
      run: (value: unknown) => {
        aborted.push(["attached", value]);
      },
    });

    const promise = scoped(appScope, () => attachedFx(1));

    await waitForMicrotask();
    await scoped(appScope, () => attachedFx.abort(reason));

    await expect(promise).rejects.toBe(reason);
    expect(aborted).toEqual([["attached", { params: 1, reason }]]);
  });

  it("uses scoped handlers of the base effect", async () => {
    const requestFx = effect((id: number) => `real:${id}`);
    const appScope = scope({
      handlers: [[requestFx, (id) => `mock:${id}`]],
    });
    const attachedFx = attach({
      effect: requestFx,
      mapParams: (id: number) => id * 2,
    });

    await expect(scoped(appScope, () => attachedFx(3))).resolves.toBe("mock:6");
  });
});

function waitForMicrotask(): Promise<void> {
  return Promise.resolve();
}
