import { describe, expect, it, vi } from "vitest";
import {
  computed,
  dependency,
  reactive,
  scope,
  scoped,
  seedScopeStoreValue,
  serialize,
  store,
  type ScopeSnapshot,
} from "../../lib";
import { withSidScope, withTransaction } from "../../lib/internal";

describe("scope snapshots", () => {
  it("keeps logical native defaults in snapshots and distinguishes an explicit undefined", () => {
    const count = store<number | undefined>(1, undefined, { sid: "lazy-default" });
    const first = scope();
    expect(scoped(first, () => count.value)).toBe(1);
    expect(serialize(first)).toEqual({ "lazy-default": 1 });
    const frozen = scope({ snapshot: serialize(first) });
    scoped(first, () => { count.value = 3; });
    expect(scoped(frozen, () => count.value)).toBe(1);
    const explicit = scope({ values: [[count, undefined]] });
    expect(scoped(explicit, () => count.value)).toBeUndefined();
    expect(() => serialize(explicit)).toThrow(/unsupported undefined/);
  });
  it("restores a module store lazily before a computed's first read", () => {
    const count = store(0, undefined, { sid: "count" });
    const doubled = computed(() => count.value * 2, undefined, { sid: "derived" });
    const request = scope({ snapshot: { count: 7, unused: 100 } });

    expect(serialize(request)).toEqual({});
    expect(scoped(request, () => doubled.value)).toBe(14);
    expect(serialize(request)).toEqual({ count: 7 });

    scoped(request, () => {
      count.value += 1;
    });
    expect(scoped(request, () => doubled.value)).toBe(16);
    expect(serialize(request)).toEqual({ count: 8 });
  });

  it("hydrates a store declared after its scope from an independent server store", () => {
    const serverStore = store("initial", undefined, { sid: "name" });
    const server = scope();
    scoped(server, () => {
      serverStore.value = "server";
    });
    const client = scope({ snapshot: JSON.parse(JSON.stringify(serialize(server))) });
    const clientStore = store("client default", undefined, { sid: "name" });

    expect(scoped(client, () => clientStore.value)).toBe("server");
  });

  it("applies a snapshot before the first write and scoped subscription", () => {
    const count = store(0, undefined, { sid: "count" });
    const request = scope({ snapshot: { count: 7 } });
    const subscriber = vi.fn();
    const off = scoped(request, () => count.subscribe(subscriber));
    expect(serialize(request)).toEqual({ count: 7 });
    expect(subscriber).not.toHaveBeenCalled();

    scoped(request, () => {
      count.value += 1;
    });
    expect(subscriber).toHaveBeenCalledWith(8, request);
    off();

    const untouched = scope({ snapshot: { count: 9 } });
    scoped(untouched, () => {
      count.value += 1;
    });
    expect(serialize(untouched)).toEqual({ count: 10 });
  });

  it("lets explicit values override pending snapshots before derived evaluation", () => {
    const count = store(0, undefined, { sid: "count" });
    const doubled = count.map((value) => value * 2);
    const request = scope({ snapshot: { count: 7 }, values: [[count, 3]] });
    expect(scoped(request, () => doubled.value)).toBe(6);
    expect(serialize(request)).toEqual({ count: 3 });

    const seeded = scope({ snapshot: { count: 7 } });
    seedScopeStoreValue(seeded, count, 5);
    expect(scoped(seeded, () => doubled.value)).toBe(10);
  });

  it("isolates request snapshots and clones both input and output records", () => {
    const data = store({ name: "default" }, undefined, { sid: "data" });
    const input = { data: { name: "original" } };
    const first = scope({ snapshot: input });
    const second = scope({ snapshot: input });
    input.data.name = "changed input";
    scoped(first, () => {
      data.value.name = "first only";
    });
    expect(scoped(second, () => data.value.name)).toBe("original");
    const output = serialize(first);
    (output.data as { name: string }).name = "changed output";
    expect(scoped(first, () => data.value.name)).toBe("first only");
  });

  it("serializes the same staged values a read sees inside a transaction", () => {
    const count = store(0, undefined, { sid: "count" });
    const request = scope();
    scoped(request, () =>
      withTransaction(() => {
        count.value = 3;
        expect(serialize(request)).toEqual({ count: 3 });
      }),
    );
    expect(serialize(request)).toEqual({ count: 3 });
  });

  it("restores and serializes reactive state without exposing store metadata", () => {
    const user = reactive({ name: "default", age: 0 }, undefined, { sid: "user" });
    const request = scope({ snapshot: { user: { name: "Ann", age: 30 } } });
    expect(scoped(request, () => [user.name, user.age])).toEqual(["Ann", 30]);
    scoped(request, () => {
      user.age += 1;
    });
    expect(serialize(request)).toEqual({ user: { name: "Ann", age: 31 } });
    expect(scoped(request, () => Object.keys(user))).toEqual(["name", "age"]);
  });

  it("does not serialize anonymous stores, dependencies, or computed caches", () => {
    const count = store(1, undefined, { sid: "count" });
    const anonymous = store("private");
    const api = dependency<{ secret: string }>();
    const doubled = computed(() => count.value * 2, undefined, { sid: "computed" });
    const request = scope({ deps: [[api, { secret: "server-only" }]] });
    scoped(request, () => {
      void doubled.value;
      void anonymous.value;
      void api.value;
    });
    expect(serialize(request)).toEqual({ count: 1 });
  });

  it("rejects duplicate materialized SIDs in one scope but permits independent requests", () => {
    const first = store(1, undefined, { sid: "same" });
    const second = store(2, undefined, { sid: "same" });
    const a = scope();
    const b = scope();
    expect(scoped(a, () => first.value)).toBe(1);
    expect(scoped(b, () => second.value)).toBe(2);
    expect(() => scoped(a, () => second.value)).toThrow(/Duplicate store SID "same"/);
    expect(serialize(a)).toEqual({ same: 1 });
    expect(serialize(b)).toEqual({ same: 2 });
    expect(() =>
      scope({
        values: [
          [first, 3],
          [second, 4],
        ],
      }),
    ).toThrow(/Duplicate store SID/);
  });

  it("resolves exact nested declaration namespaces and restores them after errors", () => {
    const shared = store(0, undefined, { sid: "shared" });
    const outer = withSidScope("ui/0", () => {
      const item = store(1, undefined, { sid: "local" });
      const nested = withSidScope("ui/1", () => store(2, undefined, { sid: "local" }));
      expect(() =>
        withSidScope("failed", () => {
          throw new Error("stop");
        }),
      ).toThrow("stop");
      const after = store(3, undefined, { sid: "after" });
      return { item, nested, after };
    });
    const after = store(4, undefined, { sid: "outside" });
    expect([shared.sid, outer.item.sid, outer.nested.sid, outer.after.sid, after.sid]).toEqual([
      "shared",
      "ui/0/local",
      "ui/1/local",
      "ui/0/after",
      "outside",
    ]);
    const request = scope({ snapshot: { "ui/0/local": 10, "ui/1/local": 20 } });
    expect(scoped(request, () => [outer.item.value, outer.nested.value])).toEqual([10, 20]);
    expect(store(0).sid).toBeUndefined();
  });

  it("does not shadow an existing reactive sid field without SID metadata", () => {
    const data = reactive({ sid: "business-id" });
    expect(scoped(scope(), () => data.sid)).toBe("business-id");
  });

  it("preserves the explicit undefined skip-token contract after compiler metadata injection", () => {
    const skipped = store<number | undefined>(1, undefined, { sid: "skipped", hasSkipToken: true });
    const accepted = store<number | undefined>(1, undefined, { sid: "accepted" });
    const request = scope();
    scoped(request, () => {
      skipped.value = undefined;
      accepted.value = undefined;
      expect(skipped.value).toBe(1);
      expect(accepted.value).toBeUndefined();
    });
  });

  it("handles prototype-like SIDs and nested keys as data", () => {
    const value = store({}, undefined, { sid: "__proto__" });
    const request = scope({ snapshot: JSON.parse('{"__proto__":{"__proto__":{"safe":true}}}') });
    scoped(request, () => {
      void value.value;
    });
    const output = serialize(request);
    expect(Object.getPrototypeOf(output)).toBeNull();
    expect(JSON.stringify(output)).toBe('{"__proto__":{"__proto__":{"safe":true}}}');
    expect(({} as { safe?: boolean }).safe).toBeUndefined();
  });

  it.each([
    ["undefined", undefined],
    ["NaN", NaN],
    ["infinity", Infinity],
    ["negative zero", -0],
    ["bigint", 1n],
    ["function", () => {}],
    ["symbol", Symbol("value")],
    ["date", new Date(0)],
    ["map", new Map()],
    ["sparse array", Array(2)],
  ])("rejects lossy %s snapshot values", (_name, value) => {
    const state = store(value, undefined, { sid: "state" });
    const request = scope();
    scoped(request, () => {
      void state.value;
    });
    expect(() => serialize(request)).toThrow(/Cannot serialize/);
    expect(() => scope({ snapshot: { state: value } as ScopeSnapshot })).toThrow(
      /Cannot serialize/,
    );
  });

  it("rejects cycles and accessors without invoking them", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => scope({ snapshot: { cyclic } as ScopeSnapshot })).toThrow(/cyclic/);
    const getter = vi.fn(() => "hidden");
    const snapshot = Object.defineProperty({}, "value", { enumerable: true, get: getter });
    expect(() => scope({ snapshot })).toThrow(/accessors/);
    expect(getter).not.toHaveBeenCalled();
  });
});
