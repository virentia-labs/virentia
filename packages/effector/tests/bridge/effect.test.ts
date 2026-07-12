import { afterEach, describe, expect, it } from "vitest";
import { allSettled as effectorAllSettled, createEffect } from "effector";
import { effect, getCurrentScope, scoped } from "@virentia/core";
import { fool } from "../../lib";
import { deferred, flush, makeAssociation, resetAmbientScope } from "../support/effector-harness";

afterEach(resetAmbientScope);

describe("effect bridging", () => {
  it("runs a fooled virentia effect's handler in the associated virentia scope via allSettled", async () => {
    const fx = fool(effect(async (p: number) => p * 2));
    const { e } = makeAssociation();
    const res = (await effectorAllSettled(fx as any, { scope: e, params: 3 })) as {
      status: string;
      value: number;
    };
    expect(res.status).toBe("done");
    expect(res.value).toBe(6);
  });

  it("resolves a fooled effector effect called from a virentia scope to the allSettled envelope", async () => {
    // NOTE: calling a fooled effector effect from a virentia scope resolves to the
    // effector allSettled *envelope* ({status, value}), NOT the bare Done value.
    // See suspected-bug note.
    const fx = fool(createEffect(async (p: number) => p + 1));
    const { v } = makeAssociation();
    const res = (await scoped(v, () => (fx as unknown as (n: number) => Promise<unknown>)(4))) as {
      status: string;
      value: number;
    };
    expect(res.status).toBe("done");
    expect(res.value).toBe(5);
  });

  it("surfaces a bridged virentia effect failure as an allSettled fail on the effector side", async () => {
    const fx = fool(
      effect(async (): Promise<number> => {
        throw new Error("boom");
      }),
    );
    const { e } = makeAssociation();
    const res = (await effectorAllSettled(fx as any, { scope: e, params: undefined })) as {
      status: string;
      value: Error;
    };
    expect(res.status).toBe("fail");
    expect(res.value.message).toBe("boom");
  });

  it("resolves a bridged effector effect failure with a fail envelope in the virentia scope", async () => {
    const fx = fool(
      createEffect(async (): Promise<number> => {
        throw new Error("nope");
      }),
    );
    const { v } = makeAssociation();
    const res = (await scoped(v, () =>
      (fx as unknown as (n: unknown) => Promise<unknown>)(undefined),
    )) as { status: string; value: Error };
    expect(res.status).toBe("fail");
    expect(res.value.message).toBe("nope");
  });

  it("exposes bridged effector effect pending in the effector scope while in flight", async () => {
    const gate = deferred<number>();
    const raw = createEffect((): Promise<number> => gate.promise);
    const fx = fool(raw);
    const { v, e } = makeAssociation();
    const p = scoped(v, () => (fx as unknown as (n: unknown) => Promise<unknown>)(undefined));
    await flush();
    expect(e.getState(raw.pending)).toBe(true);
    gate.resolve(1);
    await p;
    expect(e.getState(raw.pending)).toBe(false);
  });

  it("exposes bridged virentia effect pending in the virentia scope while in flight", async () => {
    const gate = deferred<number>();
    const under = effect((): Promise<number> => gate.promise);
    const fx = fool(under);
    const { v, e } = makeAssociation();
    const p = effectorAllSettled(fx as any, { scope: e, params: undefined });
    await flush();
    let during: boolean | undefined;
    scoped(v, () => { during = (under.pending as unknown as { value: boolean }).value; });
    expect(during).toBe(true);
    gate.resolve(1);
    await p;
    let after: boolean | undefined;
    scoped(v, () => { after = (under.pending as unknown as { value: boolean }).value; });
    expect(after).toBe(false);
  });

  it("pairs each concurrent effect launch with an active virentia scope in FIFO order", async () => {
    const seen: Array<{ p: number; scoped: boolean }> = [];
    const under = effect(async (p: number): Promise<number> => {
      seen.push({ p, scoped: getCurrentScope() !== null });
      return p;
    });
    const fx = fool(under);
    const { e } = makeAssociation();
    const r1 = effectorAllSettled(fx as any, { scope: e, params: 1 });
    const r2 = effectorAllSettled(fx as any, { scope: e, params: 2 });
    await Promise.all([r1, r2]);
    // Both handler invocations resolved against a live paired scope, in launch order.
    expect(seen).toEqual([
      { p: 1, scoped: true },
      { p: 2, scoped: true },
    ]);
  });

  it("pairs each sequential cross-scope bridged effect launch with its own scope", async () => {
    const ran: number[] = [];
    const under = effect(async (p: number): Promise<number> => {
      ran.push(p);
      return p;
    });
    const fx = fool(under);
    const { e: e1 } = makeAssociation();
    const { e: e2 } = makeAssociation();
    const s1 = (await effectorAllSettled(fx as any, { scope: e1, params: 10 })) as {
      status: string;
      value: number;
    };
    const s2 = (await effectorAllSettled(fx as any, { scope: e2, params: 20 })) as {
      status: string;
      value: number;
    };
    expect(s1.status).toBe("done");
    expect(s2.status).toBe("done");
    expect(ran).toEqual([10, 20]);
  });

  // SUSPECTED BUG (high): two bridged-effect launches on the SAME fooled virentia
  // effect in DIFFERENT effector scopes, started concurrently, should each run against
  // their own paired scope. They do not: while scope-1's callAssociation holds v1 as the
  // ambient virentia scope, scope-2's bridge scope-node resolves and trips the cross-scope
  // contamination guard, so the second launch deterministically FAILS. The scopeQueue
  // FIFO pairing does not isolate concurrent cross-scope launches. `it.fails` pins this:
  // it will start failing (alerting maintainers) once the bug is fixed.
  it.fails(
    "[BUG] concurrent cross-scope bridged effect launches do not both succeed",
    async () => {
      const ran: number[] = [];
      const under = effect(async (p: number): Promise<number> => {
        ran.push(p);
        return p;
      });
      const fx = fool(under);
      const { e: e1 } = makeAssociation();
      const { e: e2 } = makeAssociation();
      const r1 = effectorAllSettled(fx as any, { scope: e1, params: 10 });
      const r2 = effectorAllSettled(fx as any, { scope: e2, params: 20 });
      const [s1, s2] = (await Promise.all([r1, r2])) as Array<{ status: string }>;
      expect(s1.status).toBe("done");
      expect(s2.status).toBe("done"); // currently "fail" -> this assertion throws (bug present)
      expect(ran.sort((a, b) => a - b)).toEqual([10, 20]);
    },
  );
});
