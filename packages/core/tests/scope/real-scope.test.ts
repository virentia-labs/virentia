import { afterEach, describe, expect, it } from "vitest";
import { computed, effect, reaction, scope, scoped, store } from "../../lib";
import type { Scope } from "../../lib";
import { getActiveRealScope, getActiveScope } from "../../lib/scope/internal";
import { unwrapMicroScope } from "../../lib/scope/micro";
import { flush, resetActiveScope } from "../support/scope-helpers";

afterEach(resetActiveScope);

// A unit without a context of its own is read and written in the real scope
// behind the ambient one, resolved once whenever the ambient scope changes.
// It must be the scope an unwrap of the ambient scope gives at that moment.
function realScopeNow(): Scope | null {
  const real = getActiveRealScope();
  expect(real).toBe(unwrapMicroScope(getActiveScope()));
  return real;
}

describe("the real scope of the current execution", () => {
  it("follows scoped, a nested scoped and a throw out of one", () => {
    const outer = scope(),
      inner = scope();
    expect(realScopeNow()).toBe(null);
    scoped(outer, () => {
      expect(realScopeNow()).toBe(outer);
      scoped(inner, () => {
        expect(realScopeNow()).toBe(inner);
      });
      expect(realScopeNow()).toBe(outer);
      expect(() =>
        scoped(inner, () => {
          throw new Error("boom");
        }),
      ).toThrow("boom");
      expect(realScopeNow()).toBe(outer);
    });
    expect(realScopeNow()).toBe(null);
  });

  it("is the scope behind a reaction body's micro-scope, also after an awaited effect", async () => {
    const app = scope();
    const source = store(1);
    const seen: (Scope | null)[] = [];
    const fx = effect(async () => {
      seen.push(realScopeNow());
      await flush(2);
    });
    reaction({
      scope: app,
      run: async () => {
        void source.value;
        seen.push(realScopeNow());
        await fx();
        seen.push(realScopeNow());
      },
    });
    await flush(20);
    expect(seen).toEqual([app, app, app]);
  });

  it("is the firing scope inside a computed recomputed by a write", () => {
    const left = scope(),
      right = scope();
    const source = store(1);
    const evaluatedIn: (Scope | null)[] = [];
    const doubled = computed(() => {
      evaluatedIn.push(realScopeNow());
      return source.value * 2;
    });
    const off = doubled.subscribe(() => {});
    evaluatedIn.length = 0;
    scoped(left, () => {
      source.value = 2;
    });
    scoped(right, () => {
      source.value = 3;
    });
    expect(evaluatedIn).toEqual([left, right]);
    off();
  });
});

describe("reading a unit without a context of its own", () => {
  it("reads in the scope a computed's body switches to", () => {
    const app = scope({ values: [] }),
      other = scope();
    const base = store(1);
    const doubled = computed(() => base.value * 2);
    scoped(other, () => {
      base.value = 5;
    });
    const mixed = computed(() => scoped(other, () => doubled.value) * 100 + doubled.value);
    expect(scoped(app, () => mixed.value)).toBe(1002);
    scoped(app, () => {
      base.value = 3;
    });
    expect(scoped(app, () => mixed.value)).toBe(1006);
  });

  it("tracks a computed read inside a reaction body in the real scope", () => {
    const app = scope();
    const base = store(1);
    const doubled = computed(() => base.value * 2);
    const seen: number[] = [];
    const r = reaction({ scope: app, run: () => seen.push(doubled.value) });
    scoped(app, () => {
      base.value = 4;
    });
    expect(seen).toEqual([2, 8]);
    expect(scoped(app, () => doubled.value)).toBe(8);
    r.stop();
  });

  it("writes and reads back a store in the real scope from a reaction body", () => {
    const app = scope();
    const trigger = store(0),
      target = store(0);
    const r = reaction({
      scope: app,
      run: () => {
        target.value = trigger.value + 1;
      },
    });
    scoped(app, () => {
      trigger.value = 10;
    });
    expect(scoped(app, () => target.value)).toBe(11);
    expect(scoped(scope(), () => target.value)).toBe(0);
    r.stop();
  });

  it("still requires a scope", () => {
    const base = store(1);
    const doubled = computed(() => base.value * 2);
    expect(() => base.value).toThrow(/Scope is required/);
    expect(() => doubled.value).toThrow(/Scope is required/);
    expect(() => {
      base.value = 2;
    }).toThrow(/Scope is required/);
  });
});
