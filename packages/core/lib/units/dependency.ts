import type { Scope } from "../scope";
import { requireActiveScope } from "../scope/internal";
import { unwrapMicroScope } from "../scope/micro";
import { getNodeCallStackTrace } from "../kernel/call-stack";

// A dependency is a per-scope injectable — an API client, a clock, a logger:
// something the model needs but that is *not state*. Unlike a store it never
// lives in `scope.values`, so it is never serialized or hydrated (an SSR
// snapshot carries state, not wiring). Each scope provides its own instance (a
// real client in production, a mock in tests), and reading one is not a reactive
// dependency — dependencies do not change over a scope's life.
export interface Dependency<T> {
  readonly value: T;
}

const dependencyIds = new WeakMap<object, symbol>();

export function dependency<T>(name?: string): Dependency<T> {
  const id = Symbol(name ? `virentia.dependency:${name}` : "virentia.dependency");
  const label = name ? `dependency "${name}"` : "dependency";

  const self: Dependency<T> = {
    get value(): T {
      const scope = unwrapMicroScope(requireActiveScope(() => `read ${label}`));

      if (!scope.deps.has(id)) {
        throw dependencyNotProvidedError(label);
      }

      return scope.deps.get(id) as T;
    },
  };

  dependencyIds.set(self, id);

  return self;
}

// Provide a dependency's value for a scope. Use it when seeding a scope — a real
// client in production, a double in tests. Set it before the scope runs work
// that reads the dependency; it is not reactive.
export function provideDependency<T>(scope: Scope, dep: Dependency<T>, value: T): void {
  unwrapMicroScope(scope).deps.set(dependencyId(dep), value);
}

// Internal: the symbol a dependency stores its value under in `scope.deps`.
export function dependencyId(dep: Dependency<unknown>): symbol {
  const id = dependencyIds.get(dep as object);

  if (!id) {
    throw new Error("Unknown dependency: it was not created by dependency().");
  }

  return id;
}

function dependencyNotProvidedError(label: string): Error {
  const trace = getNodeCallStackTrace();
  const path =
    trace.length > 0 ? `\nUnit path that led here: ${trace.join(" → ")} → read ${label}.` : "";

  return new Error(
    `Dependency is required: ${label} is not provided in the active scope.\n` +
      "Provide it when creating the scope — scope({ deps: [[dep, value]] }) — " +
      "or imperatively with provideDependency(scope, dep, value)." +
      path,
  );
}
