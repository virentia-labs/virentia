import { describe, expect, it } from "vitest";
import {
  allSettled,
  dependency,
  effect,
  event,
  provideDependency,
  reaction,
  scope,
  scoped,
  store,
} from "../lib";

interface Api {
  get(id: string): string;
}

describe("dependency", () => {
  it("provides a different instance per scope", async () => {
    const api = dependency<Api>("api");
    const loadFx = effect(async (id: string) => api.value.get(id));
    const result = store("");

    reaction({ on: loadFx.doneData, run: (value) => (result.value = value) });

    const prod = scope({ deps: [[api, { get: (id: string) => `prod:${id}` }]] });
    const test = scope({ deps: [[api, { get: (id: string) => `mock:${id}` }]] });

    await allSettled(loadFx, { scope: prod, payload: "42" });
    expect(scoped(prod, () => result.value)).toBe("prod:42");

    await allSettled(loadFx, { scope: test, payload: "42" });
    expect(scoped(test, () => result.value)).toBe("mock:42");
  });

  it("can be provided imperatively after scope creation", () => {
    const clock = dependency<() => number>("clock");
    const s = scope();

    provideDependency(s, clock, () => 123);

    expect(scoped(s, () => clock.value())).toBe(123);
  });

  it("throws a clear error when not provided", async () => {
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
    await allSettled(ping, { scope: s });

    expect(seen).toEqual(["hello"]);
  });

  it("is not stored in the serializable `values` of a scope", () => {
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
