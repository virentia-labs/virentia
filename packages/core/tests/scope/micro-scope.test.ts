import { afterEach, describe, expect, it } from "vitest";
import { dependency, getCurrentScope, provideDependency, reaction, scope, scoped, store } from "../../lib";
import type { Scope } from "../../lib";
import { node } from "../../lib/internal";
import {
  createMicroScope,
  isMicroScope,
  readMicroDependencies,
  trackMicroDependency,
  unwrapMicroScope,
} from "../../lib/scope/micro";
import { dependencyId } from "../../lib/units/dependency";
import { resetActiveScope } from "../support/scope-helpers";

afterEach(resetActiveScope);

describe("micro-scope", () => {
  it("is the ambient scope inside an auto-reaction body", () => {
    let captured = null as Scope | null;
    const s = scope();
    const trigger = store(0);

    // An auto-reaction tracks its reads inside a per-run micro-scope, so the
    // active scope during its body is a micro-scope (unlike an explicit `on:`
    // reaction, which runs in the real firing scope).
    scoped(s, () => {
      reaction(() => {
        void trigger.value; // tracked read
        captured = getCurrentScope();
      });
    });

    // Re-fire the reaction by writing its tracked dependency inside the scope.
    captured = null;
    scoped(s, () => {
      trigger.value = 1;
    });

    expect(captured).not.toBeNull();
    expect(isMicroScope(captured)).toBe(true);
    expect(unwrapMicroScope(captured)).toBe(s);
  });

  it("shares the parent's maps by reference with a distinct identity", () => {
    const p = scope();
    const m = createMicroScope(p);

    expect(m.values).toBe(p.values);
    expect(m.handlers).toBe(p.handlers);
    expect(m.deps).toBe(p.deps);
    expect(m).not.toBe(p);
    expect(isMicroScope(m)).toBe(true);
    expect(isMicroScope(p)).toBe(false);
  });

  it("flattens a micro over a micro to the real parent", () => {
    const p = scope();
    const m1 = createMicroScope(p);
    const m2 = createMicroScope(m1);

    expect(unwrapMicroScope(m2)).toBe(p);
    expect(m2.values).toBe(p.values);
    expect(isMicroScope(m2)).toBe(true);
  });

  it("passes real scopes, null, and undefined through unwrap unchanged", () => {
    const real = scope();

    expect(unwrapMicroScope(real)).toBe(real);
    expect(unwrapMicroScope(null)).toBe(null);
    expect(unwrapMicroScope(undefined as unknown as Scope | null)).toBe(undefined);
  });

  it("identifies only a micro-scope, not null, undefined, or a real scope", () => {
    expect(isMicroScope(null)).toBe(false);
    expect(isMicroScope(undefined)).toBe(false);
    expect(isMicroScope(scope())).toBe(false);
    expect(isMicroScope(createMicroScope(scope()))).toBe(true);
  });

  it("deduplicates a repeated tracked dependency", () => {
    const m = createMicroScope(scope());
    const a = node({});

    trackMicroDependency(m, a);
    trackMicroDependency(m, a);

    const deps = readMicroDependencies(m);
    expect(deps?.size).toBe(1);
    expect(deps?.has(a)).toBe(true);

    expect(readMicroDependencies(scope())).toBeUndefined();
  });

  it("writes a dependency provided through a micro to the real parent", () => {
    const p = scope();
    const m = createMicroScope(p);
    const dep = dependency<number>("val");

    provideDependency(m, dep, 123);

    expect(p.deps.get(dependencyId(dep))).toBe(123);
    expect(scoped(p, () => dep.value)).toBe(123);
  });
});
