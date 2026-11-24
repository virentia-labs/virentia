import { describe, expect, it, vi } from "vitest";
import { computed, dependency, getCurrentScope, scope, scoped, serialize, store } from "../../lib";
import { captureScopeSnapshot, withTransaction } from "../../lib/internal";
import { getScopedObservers } from "../../lib/kernel/scoped-edges";
import { createMicroScope } from "../../lib/scope/micro";

describe("temporary hydration read snapshots", () => {
  it("captures SID and anonymous values without changing the live scope or ambient scope", () => {
    const named = store(1, undefined, { sid: "named" });
    const anonymous = store({ label: "first" });
    const live = scope({ values: [[named, 2]] });
    const originalObject = scoped(live, () => anonymous.value);
    const subscribed = vi.fn();
    const unsubscribe = anonymous.subscribe(subscribed);
    const ambient = getCurrentScope();
    const frozen = captureScopeSnapshot(createMicroScope(live));
    expect(getCurrentScope()).toBe(ambient);
    expect(frozen.values).not.toBe(live.values);

    scoped(live, () => {
      named.value = 3;
      anonymous.value = { label: "second" };
    });
    expect(scoped(frozen, () => [named.value, anonymous.value])).toEqual([2, { label: "first" }]);
    expect(scoped(frozen, () => anonymous.value)).toBe(originalObject);
    expect(scoped(live, () => [named.value, anonymous.value.label])).toEqual([3, "second"]);
    expect(serialize(frozen)).toEqual({ named: 2 });
    expect(serialize(live)).toEqual({ named: 3 });
    expect(subscribed).toHaveBeenCalledTimes(1);
    expect(getCurrentScope()).toBe(ambient);
    unsubscribe();
  });

  it("preserves unread SID restoration independently of the live registry", () => {
    const named = store("initial", undefined, { sid: "unread" });
    const live = scope({ snapshot: { unread: "server" } });
    const frozen = captureScopeSnapshot(live);
    expect(serialize(live)).toEqual({});
    expect(scoped(frozen, () => named.value)).toBe("server");
    expect(serialize(live)).toEqual({});
    scoped(live, () => {
      named.value = "client";
    });
    expect(scoped(frozen, () => named.value)).toBe("server");
    expect(serialize(live)).toEqual({ unread: "client" });
  });

  it("recomputes derived values from captured state without sharing caches or attaching edges", () => {
    const value = store(2);
    const evaluate = vi.fn(() => value.value * 2);
    const doubled = computed(evaluate);
    const live = scope();
    expect(scoped(live, () => doubled.value)).toBe(4);
    const frozen = captureScopeSnapshot(live);
    scoped(live, () => {
      value.value = 5;
    });
    expect(scoped(live, () => doubled.value)).toBe(10);
    expect(scoped(frozen, () => doubled.value)).toBe(4);
    expect(evaluate).toHaveBeenCalledTimes(3);
    expect(getScopedObservers(frozen, value.node)).toBeUndefined();
    scoped(live, () => {
      value.value = 7;
    });
    expect(scoped(frozen, () => doubled.value)).toBe(4);
    expect(scoped(live, () => doubled.value)).toBe(14);
  });

  it("captures staged writes and provides independent dependency and handler maps", () => {
    const value = store(1);
    const api = dependency<{ name: string }>();
    const provided = { name: "api" };
    const handler = () => "handled";
    const handlerKey = {};
    const live = scope({ deps: [[api, provided]] });
    live.handlers.set(handlerKey, handler);
    let frozen!: ReturnType<typeof captureScopeSnapshot>;
    scoped(live, () =>
      withTransaction(() => {
        value.value = 8;
        frozen = captureScopeSnapshot(live);
        value.value = 9;
      }),
    );
    expect(scoped(frozen, () => value.value)).toBe(8);
    expect(scoped(live, () => value.value)).toBe(9);
    expect(scoped(frozen, () => api.value)).toBe(provided);
    expect(frozen.handlers.get(handlerKey)).toBe(handler);
    expect(frozen.handlers).not.toBe(live.handlers);
    expect(frozen.deps).not.toBe(live.deps);
    live.handlers.clear();
    live.deps.clear();
    expect(frozen.handlers.get(handlerKey)).toBe(handler);
    expect(scoped(frozen, () => api.value)).toBe(provided);
  });
});
