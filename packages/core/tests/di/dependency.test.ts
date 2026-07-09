import { describe, expect, it } from "vitest";
import {
  dependency,
  effect,
  event,
  provideDependency,
  reaction,
  scope,
  scoped,
  store,
} from "../../lib";
import { createMicroScope, readMicroDependencies } from "../../lib/scope/micro";
import { setActiveScope } from "../../lib/scope/internal";

interface Api {
  get(id: string): string;
}

describe("dependency", () => {
  it("keeps two same-name dependencies as independent injectables", async () => {
    const first = dependency<Api>("api");
    const second = dependency<Api>("api");
    const s = scope({ deps: [[first, { get: (id: string) => `first:${id}` }]] });

    expect(scoped(s, () => first.value.get("x"))).toBe("first:x");
    // The scope provided only `first`; `second` shares the *name* but is a
    // distinct symbol id, so it reads as not-provided.
    expect(() => scoped(s, () => second.value)).toThrow(/Dependency is required/);
  });

  it("returns the exact provided value under a scope that provided it", () => {
    const cfg = dependency<{ url: string }>("cfg");
    const value = { url: "https://example" };
    const s = scope({ deps: [[cfg, value]] });

    expect(scoped(s, () => cfg.value)).toBe(value);
  });

  it("reads its own instance in each scope", () => {
    const clock = dependency<() => number>("clock");
    const a = scope({ deps: [[clock, () => 1]] });
    const b = scope({ deps: [[clock, () => 2]] });

    expect(scoped(a, () => clock.value())).toBe(1);
    expect(scoped(b, () => clock.value())).toBe(2);
  });

  it("resolves nested reads against the innermost active scope", () => {
    const label = dependency<string>("label");
    const outer = scope({ deps: [[label, "A"]] });
    const inner = scope({ deps: [[label, "B"]] });

    const seen = scoped(outer, () => {
      const outerValue = label.value;
      const innerValue = scoped(inner, () => label.value);
      return [outerValue, innerValue, label.value];
    });

    expect(seen).toEqual(["A", "B", "A"]);
  });

  it("throws a scope-required error naming the dependency on a scopeless read", () => {
    const clock = dependency<() => number>("clock");

    expect(() => clock.value).toThrow(/Scope is required to read dependency "clock"/);
  });

  it("names an anonymous dependency generically in the scopeless error", () => {
    const anon = dependency<number>();

    expect(() => anon.value).toThrow(/Scope is required to read dependency\b/);
  });

  it("throws an actionable error under a scope that never provided it", () => {
    const api = dependency<Api>("api");
    const s = scope();

    expect(() => scoped(s, () => api.value)).toThrow(
      /Dependency is required: dependency "api" is not provided in the active scope/,
    );
  });

  it("seeds a scope imperatively through provideDependency after creation", () => {
    const clock = dependency<() => number>("clock");
    const s = scope();

    provideDependency(s, clock, () => 123);

    expect(scoped(s, () => clock.value())).toBe(123);
  });

  it("lives in scope.deps rather than scope.values", () => {
    const api = dependency<Api>("api");
    const count = store(0);
    const s = scope({ values: [[count, 5]], deps: [[api, { get: () => "x" }]] });

    expect(s.deps.size).toBe(1);
    expect([...s.values.values()]).toEqual([5]);
  });

  it("rejects a foreign object that dependency() never created", () => {
    const s = scope();

    expect(() => provideDependency(s, { value: 1 } as unknown as never, "x")).toThrow(
      /Unknown dependency: it was not created by dependency\(\)\./,
    );
  });

  it("applies last-write-wins when provided twice for the same scope", () => {
    const dep = dependency<string>("d");
    const s = scope();

    provideDependency(s, dep, "a");
    provideDependency(s, dep, "b");

    expect(scoped(s, () => dep.value)).toBe("b");
    expect(s.deps.size).toBe(1);
  });

  it("appends the unit call-stack trace to a not-provided error", async () => {
    const api = dependency<Api>("api");
    const readFx = effect(async () => api.value.get("x"));
    const s = scope();

    await expect(scoped(s, () => readFx())).rejects.toThrow(/Unit path that led here:/);
  });

  it("succeeds on a re-read after a late provide in the same scope", () => {
    const dep = dependency<number>("late");
    const s = scope();

    expect(() => scoped(s, () => dep.value)).toThrow(/Dependency is required/);

    provideDependency(s, dep, 7);

    // The getter re-reads scope.deps on every access, so the late provide wins.
    expect(scoped(s, () => dep.value)).toBe(7);
  });

  it("accepts undefined as a legitimately provided value", () => {
    const dep = dependency<number | undefined>("maybe");
    const s = scope();

    provideDependency(s, dep, undefined);

    expect(s.deps.size).toBe(1);
    expect(scoped(s, () => dep.value)).toBeUndefined();
  });

  it("unwraps a micro-scope to the real parent when providing", async () => {
    const dep = dependency<number>("micro");
    const real = scope();
    const ping = event<void>();

    // A reaction body runs under a micro-scope overlay. Providing there must
    // land on the real parent's deps map, not a throwaway overlay.
    reaction({
      on: ping,
      run: () => {
        provideDependency(createMicroScope(real), dep, 5);
      },
    });

    // Provide directly onto a micro-scope of `real`.
    provideDependency(createMicroScope(real), dep, 5);

    expect(scoped(real, () => dep.value)).toBe(5);
  });

  it("does not track a dependency read as a reactive dependency in a micro-scope", () => {
    const dep = dependency<number>("untracked");
    const st = store(0);
    const real = scope({ deps: [[dep, 42]] });
    const micro = createMicroScope(real);

    const previous = setActiveScope(micro);
    try {
      // A store read via `.value` records a micro-dependency; a dependency read
      // must not add anything (dependencies are not reactive).
      void st.value;
      void dep.value;
    } finally {
      setActiveScope(previous);
    }

    const deps = readMicroDependencies(micro);
    expect(deps).toBeDefined();
    expect(deps!.has(st.node)).toBe(true);
    // Only the store's node is tracked — the dependency added nothing.
    expect(deps!.size).toBe(1);
  });

  it("provides a different instance per scope", async () => {
    const api = dependency<Api>("api");
    const loadFx = effect(async (id: string) => api.value.get(id));
    const result = store("");

    reaction({ on: loadFx.doneData, run: (value) => (result.value = value) });

    const prod = scope({ deps: [[api, { get: (id: string) => `prod:${id}` }]] });
    const test = scope({ deps: [[api, { get: (id: string) => `mock:${id}` }]] });

    await scoped(prod, () => loadFx("42"));
    expect(scoped(prod, () => result.value)).toBe("prod:42");

    await scoped(test, () => loadFx("42"));
    expect(scoped(test, () => result.value)).toBe("mock:42");
  });

  it("rejects an effect reading an unprovided dependency with an actionable message", async () => {
    const api = dependency<Api>("api");
    const callFx = effect(async () => api.value.get("x"));
    const s = scope();

    // The effect handler reads a dependency the scope never provided; the
    // effect's promise rejects with an actionable message.
    await expect(scoped(s, () => callFx())).rejects.toThrow(
      /Dependency is required: dependency "api" is not provided/,
    );

    // A plain read outside any scope also throws (needs an active scope first).
    expect(() => api.value).toThrow(/Scope is required/);
  });

  it("reads inside a reaction body under an active scope", async () => {
    const label = dependency<string>("label");
    const seen: string[] = [];
    const ping = event<void>();

    reaction({ on: ping, run: () => seen.push(label.value) });

    const s = scope({ deps: [[label, "hello"]] });
    await scoped(s, () => ping());

    expect(seen).toEqual(["hello"]);
  });

  it("stays out of the serializable values of a scope", () => {
    const api = dependency<Api>("api");
    const count = store(0);
    const s = scope({
      values: [[count, 5]],
      deps: [[api, { get: () => "x" }]],
    });

    // The dependency lives in `deps`, never in `values` (what SSR serializes).
    expect(s.deps.size).toBe(1);
    // `values` holds only the seeded store, not the dependency.
    expect([...s.values.values()]).toContain(5);
    expect([...s.values.values()]).not.toContainEqual({ get: expect.any(Function) });
  });
});
