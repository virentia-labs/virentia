import { afterEach, describe, expect, it } from "vitest";
import { computed, dependency, effect, scope, scoped, store } from "../../lib";
import type { EffectHandler, Scope, StoreWritable } from "../../lib";
import { onInspectorEvent } from "../../lib/kernel/inspector";
import { resetActiveScope } from "../support/scope-helpers";

afterEach(resetActiveScope);

describe("scope", () => {
  it("starts with three empty, mutually-independent maps", () => {
    const s = scope();

    expect(s.values.size).toBe(0);
    expect(s.handlers.size).toBe(0);
    expect(s.deps.size).toBe(0);

    // Distinct Map references.
    expect(s.values).not.toBe(s.handlers as unknown);
    expect(s.values).not.toBe(s.deps as unknown);
    expect(s.handlers).not.toBe(s.deps as unknown);

    const other = scope();
    expect(s.values).not.toBe(other.values);
    expect(s.handlers).not.toBe(other.handlers);
    expect(s.deps).not.toBe(other.deps);
  });

  it("reads a seeded writable store value inside the scope", () => {
    const value = store(0);
    const s = scope({ values: [[value, 10]] });

    expect(scoped(s, () => value.value)).toBe(10);
  });

  it("accepts a values Map identically to an array", () => {
    const st = store(0);
    const fromArray = scope({ values: [[st, 7]] });
    const fromMap = scope({ values: new Map<StoreWritable<number>, unknown>([[st, 7]]) });

    expect(scoped(fromArray, () => st.value)).toBe(7);
    expect(scoped(fromMap, () => st.value)).toBe(7);
  });

  it("accepts handler and dep Maps identically to arrays", () => {
    const fx = effect(async () => "default");
    const handler: EffectHandler<void, string> = async () => "override";
    const dep = dependency<number>("n");

    const fromMap = scope({
      handlers: new Map([[fx, handler]]),
      deps: new Map([[dep, 42]]),
    });

    expect(fromMap.handlers.get(fx)).toBe(handler);
    expect(scoped(fromMap, () => dep.value)).toBe(42);
  });

  it("overrides an effect's default handler from the scope", async () => {
    const fx = effect(async () => "default");
    const s = scope({ handlers: [[fx, async () => "override"]] });

    await expect(scoped(s, () => fx())).resolves.toBe("override");
  });

  it("isolates a handler override to its own scope", async () => {
    const fx = effect(async () => "default");
    const a = scope({ handlers: [[fx, async () => "override"]] });
    const b = scope();

    await expect(scoped(a, () => fx())).resolves.toBe("override");
    await expect(scoped(b, () => fx())).resolves.toBe("default");
  });

  it("reads a dependency provided at creation", () => {
    const client = { get: (id: string) => `v:${id}` };
    const dep = dependency<typeof client>("api");
    const s = scope({ deps: [[dep, client]] });

    expect(scoped(s, () => dep.value)).toBe(client);
  });

  it("throws when reading a dependency that was never provided", () => {
    const dep = dependency("api");
    const s = scope();

    expect(() => scoped(s, () => dep.value)).toThrow(
      /Dependency is required: dependency "api" is not provided/,
    );
  });

  it("rejects a non-writable store in its values", () => {
    // A computed is a read-only store: it has no per-scope writer registered.
    const ro = computed(() => 0);

    expect(() =>
      scope({ values: [[ro as unknown as StoreWritable<number>, 1]] }),
    ).toThrow("Scope values can contain only writable stores");
  });

  it("registers itself with the inspector on creation", () => {
    const seen: Scope[] = [];
    const off = onInspectorEvent((event) => {
      if (event.type === "scope-created") {
        seen.push(event.scope);
      }
    });

    let created: Scope;
    try {
      created = scope();
    } finally {
      off();
    }

    expect(seen).toContain(created);
  });

  it("seeds one scope without contaminating another", () => {
    const st = store(0);
    const a = scope({ values: [[st, 5]] });
    const b = scope();

    expect(scoped(a, () => st.value)).toBe(5);
    expect(scoped(b, () => st.value)).toBe(0);
    // Reading b did not lazily leak into a.
    expect(scoped(a, () => st.value)).toBe(5);
  });

  it("creates a scope with initial store values", () => {
    const value = store(0);
    const appScope = scope({
      values: [[value, 10]],
    });

    scoped(appScope, () => {
      expect(value.value).toBe(10);
    });
  });

  it("keeps an inner scope's write from leaking into the outer frame", () => {
    const outer = scope();
    const inner = scope();
    const value = store(0);

    scoped(outer, () => {
      value.value = 1;

      scoped(inner, () => {
        expect(value.value).toBe(0);
        value.value = 2;
      });

      expect(value.value).toBe(1);
    });

    scoped(inner, () => {
      expect(value.value).toBe(2);
    });
    expect(() => value.value).toThrow("Scope is required");
  });

  it("hides an outer scope's store value from a nested inner scope", () => {
    const outer = scope();
    const inner = scope();
    const st = store(0);

    scoped(outer, () => {
      st.value = 1;
      scoped(inner, () => {
        expect(st.value).toBe(0);
      });
      expect(st.value).toBe(1);
    });

    expect(scoped(inner, () => st.value)).toBe(0);
    expect(scoped(outer, () => st.value)).toBe(1);
  });

  it("keeps concurrent async scopes' synchronous writes isolated", async () => {
    const a = scope();
    const b = scope();
    const marker = store("");

    // Writes only in the synchronous body (before any await), where the ambient
    // scope is reliably installed.
    const p1 = scoped(a, async () => {
      marker.value = "a";
      await Promise.resolve();
    });
    const p2 = scoped(b, async () => {
      marker.value = "b";
      await Promise.resolve();
    });

    await Promise.all([p1, p2]);

    // Each scope kept its own write despite sharing the global ambient.
    expect(scoped(a, () => marker.value)).toBe("a");
    expect(scoped(b, () => marker.value)).toBe("b");
  });
});
