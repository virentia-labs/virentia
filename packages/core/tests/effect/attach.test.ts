import { describe, expect, it, vi } from "vitest";
import { attach, effect, reaction, scope, scoped, store } from "../../lib";
import type { Effect, EffectHandlerContext } from "../../lib";
import { tick } from "../support/async-flush";

describe("attach", () => {
  it("fires its own doneData while the base effect stays silent", async () => {
    const s = scope();
    const baseFx = effect(async (n: number) => n + 1);
    const attachedFx = attach({ effect: baseFx });
    const attachedDone: number[] = [];
    const baseDone: number[] = [];

    reaction({ on: attachedFx.doneData, run: (v: number) => attachedDone.push(v) });
    reaction({ on: baseFx.doneData, run: (v: number) => baseDone.push(v) });

    await scoped(s, () => attachedFx(10));

    // attach only invokes the base *handler* (runEffectHandler), never the base
    // effect's own call lifecycle — so base.doneData stays silent.
    expect(attachedDone).toEqual([11]);
    expect(baseDone).toEqual([]);
  });

  it("reads a single Store source as a scalar value", async () => {
    const s = scope();
    const token = store("root");
    const readFx = attach({
      source: token,
      effect: (src: string, _p: number) => src,
    });

    scoped(s, () => {
      token.value = "scoped";
    });

    await expect(scoped(s, () => readFx(1))).resolves.toBe("scoped");
  });

  it("yields a positionally-ordered array of values from an array source", async () => {
    const s = scope();
    const s1 = store(1);
    const s2 = store(2);
    const s3 = store(3);
    const collectFx = attach({
      source: [s1, s2, s3] as const,
      effect: (src: readonly number[]) => src.slice(),
    });

    await expect(scoped(s, () => collectFx(0))).resolves.toEqual([1, 2, 3]);
  });

  it("follows declaration order rather than value order for an array source", async () => {
    const s = scope();
    const a = store(30);
    const b = store(20);
    const c = store(10);
    const collectFx = attach({
      source: [a, b, c] as const,
      effect: (src: readonly number[]) => src.slice(),
    });

    // Values descend but the array must still be [a, b, c] positionally.
    await expect(scoped(s, () => collectFx(0))).resolves.toEqual([30, 20, 10]);
  });

  it("yields a same-keyed object of values from an object source", async () => {
    const s = scope();
    const locale = store("en");
    const token = store("t");
    const shapeFx = attach({
      source: { locale, token },
      effect: (src: { locale: string; token: string }) => src,
    });

    await expect(scoped(s, () => shapeFx(0))).resolves.toEqual({ locale: "en", token: "t" });
  });

  it("yields an empty array or object from an empty source", async () => {
    const s = scope();
    const arrFx = attach({ source: [] as const, effect: (src: readonly unknown[]) => src });
    const objFx = attach({ source: {}, effect: (src: Record<string, unknown>) => src });

    await expect(scoped(s, () => arrFx(0))).resolves.toEqual([]);
    await expect(scoped(s, () => objFx(0))).resolves.toEqual({});
  });

  it("calls mapParams as (params, sourceValue) for a source with a base effect", async () => {
    const s = scope();
    const token = store("T");
    const baseFx = effect(async (p: { id: number; token: string }) => `${p.token}:${p.id}`);
    const calls: Array<[number, string]> = [];
    const authorizedFx = attach({
      source: token,
      effect: baseFx,
      mapParams: (id: number, srcToken: string) => {
        calls.push([id, srcToken]);
        return { id, token: srcToken };
      },
    });

    await expect(scoped(s, () => authorizedFx(42))).resolves.toBe("T:42");
    expect(calls).toEqual([[42, "T"]]);
  });

  it("passes params through unchanged for a base effect without mapParams", async () => {
    const s = scope();
    const seen: number[] = [];
    const baseFx = effect(async (p: number) => {
      seen.push(p);
      return p;
    });
    const attachedFx = attach({ effect: baseFx });

    await expect(scoped(s, () => attachedFx(41))).resolves.toBe(41);
    expect(seen).toEqual([41]);
  });

  it("runs an inline handler as (sourceValue, params, ctx) with a source", async () => {
    const s = scope();
    const token = store("K");
    const args: unknown[] = [];
    const runFx = attach({
      source: token,
      effect: (src: string, params: number, ctx: EffectHandlerContext) => {
        args.push(src, params, typeof ctx.signal, ctx.scope === s);
        return `${src}:${params}`;
      },
    });

    await expect(scoped(s, () => runFx(7))).resolves.toBe("K:7");
    expect(args).toEqual(["K", 7, "object", true]);
  });

  it("runs an inline handler as (params, ctx) without a source", async () => {
    const s = scope();
    const shapeFx = attach({
      effect: (params: number, ctx) => ({ params, hasScope: ctx.scope === s, arity: 2 }),
    });

    await expect(scoped(s, () => shapeFx(3))).resolves.toEqual({
      params: 3,
      hasScope: true,
      arity: 2,
    });
  });

  it("honors a scope-provided handler override on the base effect", async () => {
    const requestFx = effect((id: number) => `real:${id}`);
    const s = scope({ handlers: [[requestFx, (id) => `mock:${id}`]] });
    const attachedFx = attach({ effect: requestFx, mapParams: (id: number) => id * 2 });

    await expect(scoped(s, () => attachedFx(3))).resolves.toBe("mock:6");
  });

  it("propagates an abort reason into the base effect's ctx.signal", async () => {
    const s = scope();
    const reason = new Error("stop");
    const waitFx = effect<string, string, Error>(
      (_value, { signal }) =>
        new Promise((_resolve, reject) => {
          if (signal.aborted) {
            reject(signal.reason);
            return;
          }
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    );
    const attachedFx = attach({ effect: waitFx, mapParams: (id: number) => String(id) });
    const aborted: unknown[] = [];

    reaction({
      on: attachedFx.aborted,
      run: (value: unknown) => {
        aborted.push(["attached", value]);
      },
    });

    const promise = scoped(s, () => attachedFx(1));
    await tick();
    await scoped(s, () => attachedFx.abort(reason));

    await expect(promise).rejects.toBe(reason);
    expect(aborted).toEqual([["attached", { params: 1, reason }]]);
  });

  it("rejects with the reason for an abort issued synchronously after the call", async () => {
    const s = scope();
    const reason = new Error("immediate");
    const neverFx = effect<number, number, Error>(
      (_v, { signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    );
    const attachedFx = attach({ effect: neverFx });

    const result = scoped(s, () => {
      const p = attachedFx(1);
      void attachedFx.abort(reason);
      return p;
    });

    await expect(result).rejects.toBe(reason);
  });

  it("reads source stores per scope at call time", async () => {
    const a = scope();
    const b = scope();
    const token = store("root");
    const readFx = attach({ source: token, effect: (src: string) => src });

    scoped(a, () => {
      token.value = "a";
    });
    scoped(b, () => {
      token.value = "b";
    });

    await expect(scoped(a, () => readFx(0))).resolves.toBe("a");
    await expect(scoped(b, () => readFx(0))).resolves.toBe("b");
  });

  it("ignores mapParams entirely for an inline function effect", async () => {
    const s = scope();
    // No overload accepts mapParams alongside an inline handler; the runtime
    // only consults mapParams on the isEffect branch, so it must be ignored.
    const mapParams = vi.fn(() => 999);
    const attachedFx = attach({
      effect: (p: number) => p,
      mapParams,
    } as unknown as Parameters<typeof attach>[0]) as Effect<number, number, unknown>;

    await expect(scoped(s, () => attachedFx(5))).resolves.toBe(5);
    expect(mapParams).not.toHaveBeenCalled();
  });

  it("passes sourceValue undefined to mapParams for a base effect with no source", async () => {
    const s = scope();
    const baseFx = effect(async (p: number) => p);
    let seenSource: unknown = "unset";
    const attachedFx = attach({
      effect: baseFx,
      mapParams: (p: number, src?: unknown) => {
        seenSource = src;
        return p;
      },
    } as unknown as Parameters<typeof attach>[0]) as Effect<number, number, unknown>;

    await scoped(s, () => attachedFx(1));
    expect(seenSource).toBeUndefined();
  });

  it("surfaces a rejecting base effect's failure through the attached promise and failData", async () => {
    const s = scope();
    const boom = new Error("boom");
    const baseFx = effect<number, number, Error>(async () => {
      throw boom;
    });
    const attachedFx = attach({ effect: baseFx });
    const fails: unknown[] = [];
    reaction({ on: attachedFx.failData, run: (v: unknown) => fails.push(v) });

    await expect(scoped(s, () => attachedFx(1))).rejects.toBe(boom);
    expect(fails).toEqual([boom]);
  });
});
