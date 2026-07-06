---
"@virentia/core": minor
---

Add `dependency` — a per-scope injectable that is never serialized or hydrated.

A dependency is model wiring rather than state: an API client, a clock, a logger. Each scope provides its own instance (a real client in production, a mock in tests), and unlike a store it lives in a separate `scope.deps` map, so it is excluded from anything built on `scope.values` (SSR serialization / hydration).

```ts
import { dependency, effect, provideDependency, scope } from "@virentia/core";

const api = dependency<ApiClient>("api");

const loadFx = effect(async (id: string) => api.value.get(id));

// Provide per scope — at creation or imperatively.
const appScope = scope({ deps: [[api, new RealApiClient()]] });
const testScope = scope();
provideDependency(testScope, api, new MockApiClient());
```

Read a dependency with `dep.value` under an active scope (effect handlers, reaction bodies, `scoped(...)`). Reading one is not a reactive dependency. Reading a dependency that the active scope never provided throws an actionable error. New exports: `dependency`, `provideDependency`, `Dependency`, and a `deps` option on `scope()`.
