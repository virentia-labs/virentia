# @virentia/core

## 0.8.0

### Minor Changes

- feat: granular subscription react/vue update

## 0.7.1

### Patch Changes

- fix: effector naming in inspector

## 0.7.0

### Minor Changes

- feat: some fixes, component mapProps & shape protocol

## 0.6.4

### Patch Changes

- feat: some fixes & fully tests coverage

## 0.6.3

### Patch Changes

- fix: effect types

## 0.6.2

### Patch Changes

- fix: remove useless effect payload

## 0.6.1

### Patch Changes

- fix: scoped & remove allSettled

## 0.6.0

### Minor Changes

- 4e60166: Move low-level unit-building primitives to a new `@virentia/core/internal` subpath.

  Authoring custom units and stores needs the kernel and reactive plumbing that app code should not touch. That surface now lives at `@virentia/core/internal`: `createNode`, `run`, `createContext`, `withContexts` (moved off the main entry), plus the newly exposed `trackNode`, `collectNodes`, `requireActiveScope`/`setActiveScope`/`getActiveScope`, and the transaction lifecycle (`enterTransaction`, `exitTransaction`, `withTransaction`, `commitActiveTransaction`, `writeTransactionStore`, `readTransactionStore`, and the `StoreTransactionTarget`/`StoreCommitResult` types). Kernel **types** (e.g. `Node`) remain on the main entry, since every unit exposes `.node`.

  The subpath is built into the same shared chunk as the main entry, so a package that imports it (with `@virentia/core` and `@virentia/core/internal` kept external) shares core's single transaction/scope/graph state rather than getting its own copy.

  Migration: if you imported `createNode`, `run`, `createContext`, or `withContexts` from `@virentia/core`, import them from `@virentia/core/internal` instead. App code using stores/events/effects/reactions is unaffected.

- 4e60166: `@virentia/mutable`: fine-grained, per-keypath reactivity — no API change.

  A `computed`, auto reaction, or `map` over a mutable store now re-runs only when a keypath it actually read is written. Mutating one branch no longer re-runs readers of unrelated branches:

  ```ts
  const cart = mutableStore({
    items: [] as Item[],
    coupon: null as string | null,
  });
  const count = computed(() => cart.value.items.length);
  const coupon = computed(() => cart.value.coupon);

  cart.value.items.push(item);
  // Re-runs `count` only — `coupon` never read `items`.
  ```

  The draft proxy reports each read keypath (with every prefix, so replacing an ancestor still invalidates deep readers) and each written keypath; the store maps keypaths to graph nodes and, at commit, fires only the nodes whose paths changed. `unwrap(store.value)` takes a coarse dependency (any change), and `store.subscribe` / `useUnit(store)` on the whole value stay coarse by definition. Tracking runs only while a reader is collecting dependencies, so the write path — and its benchmark lead over mutative and immer — is unchanged.

  `@virentia/core`: `@virentia/core/internal` now exports `isTracking()`, so a custom store can tell whether a read should register as a dependency.

- 4e60166: Rename the low-level kernel factories to drop the `create` prefix: `@virentia/core/internal` now exports `node()` (was `createNode`) and `context()` (was `createContext`). The `CreateNodeOptions` type is now `NodeOptions`.

  This only affects code that authors custom units/stores on `@virentia/core/internal`; application code (stores/events/effects/reactions) is unchanged. Update imports:

  ```ts
  // before
  import { createNode, createContext } from "@virentia/core/internal";
  // after
  import { node, context } from "@virentia/core/internal";
  ```

### Patch Changes

- 1f56652: Fix a deadlock when an effect handler awaits an event after awaiting another effect.

  ```ts
  const fx = effect(async () => {
    await inner(); // await another effect
    await ev("x"); // then await an event — used to hang forever
  });
  ```

  When a reentrant drain (the `await inner()` effect) finished asynchronously, it re-installed the parked parent drain as the active drain. The next unit call in the handler's continuation (`await ev()`) then joined that parked drain via `waitForDrain` and never resolved — the drain only settles once the handler finishes, and the handler was blocked on that very call. On asynchronous resume the kernel now restores whatever drain is genuinely active (usually none) instead of the stale parent captured when the drain was created, so the continuation's unit call runs on its own drain and completes.

## 0.5.0

### Minor Changes

- ab564fc: Add `dependency` — a per-scope injectable that is never serialized or hydrated.

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

### Patch Changes

- e717f00: Awaiting an event now restores the caller's scope, matching effects.

  `await someEvent()` inside a `scoped(...)` block left the ambient scope reset to `null` once the event's reactions had settled — an **async** reaction in particular — so a following store read threw "Scope is required". The event callable returned the whole drain promise, whose async tail deliberately nulls the ambient scope; an effect instead returns its own settle promise, which resolves mid-drain while the scope is still installed, which is why effects already worked.

  Events now restore the scope that was active when they were called (mirroring effects), so code after `await someEvent()` keeps running in the same scope. Every async-callable unit leaves the caller's scope as it found it. (A raw `await fetch()` still drops the scope — wrap external async in an effect.)

## 0.4.2

### Patch Changes

- bc209b9: Reactions are global by default; per-scope binding is opt-in via `scope:`.

  0.4.0 inferred per-scope binding from the scope that happened to be active when a reaction was created (`scoped(scope, () => reaction(...))`). That relied on the ambient `activeScope` global — fragile and non-deterministic, since the same model factory would behave differently depending on where it was called. A reaction with no `scope:` is now global: it re-runs whenever a store it read changes in **any** scope, reading that firing scope's value. Pass `scope:` to bind a reaction to specific scopes and isolate its automatically tracked dependencies per scope. Async dependency tracking still happens in the concrete scope each run fires in.

  Migration: if you relied on a reaction created under `scoped(scope, …)` reacting only to that scope, pass `scope:` explicitly (`reaction({ scope, run })`).

## 0.4.1

### Patch Changes

- d810688: Remove the `reaction(selector, effect)` overload.

  It was redundant with `reaction({ on: computed(selector), run: effect })`: a `computed` already dedupes on the derived value, and an explicit `on` reaction does not run at creation — which is exactly the selector form's semantics. Dropping it trims a third signature from an already heavily overloaded `reaction`. Migrate `reaction(() => expr, fn)` to `reaction({ on: computed(() => expr), run: fn })`.

## 0.4.0

### Minor Changes

- 7cb0c7e: Per-scope subscriptions & auto-tracking, async reactions, non-browser devtools, and actionable scope errors.

  - **Reactions and computed now track dependencies per scope.** A reaction created inside a scope (the usual case — model factories run under `scoped(scope, …)`) observes only that scope and no longer reacts to, or clobbers dependencies from, other scopes. A computed that reads different stores in different scopes is invalidated precisely per scope instead of from a global union of every scope's branches. Dynamic edges live in a scope-keyed `WeakMap`, so an abandoned scope (e.g. a per-request `fork`) frees its edges automatically. Module-level reactions (no active scope, no `scope:`) keep their previous global behavior.
  - **Async reactions.** Two new forms with cancel-previous (switch) semantics and integration with `allSettled`:
    - `reaction(() => selector, async (value, { scope, signal }) => { … })` — a synchronously tracked selector drives an async effect that runs only when the selected value changes.
    - `reaction({ on, run: async (payload, { scope, signal }) => { … } })` — an explicit async body.
      The body receives `{ scope, signal }`; `signal` aborts when the reaction fires again in the same scope or is stopped. An async body is awaited by `allSettled` — including any fire-and-forget effect it launches without `await`, which the drain now waits for before settling. New exports: `ReactionEffectApi`, `ReactionRun`.
  - **Auto-tracking through `await`.** An auto reaction (`reaction(() => …)` / `reaction(async () => …)`) now tracks every store it reads for the whole run — including reads _after_ an `await` — via a lightweight per-run "micro-scope" that shares the real scope's values and rides the ambient scope across effect awaits. Only the reaction's own direct reads are tracked (a computed's internal dependencies stay with the computed), and each run gets a fresh micro-scope, so overlapping async runs never mix dependencies (latest run wins). Async tracking requires awaiting effects (`await someFx()` / `await allSettled(fx, { scope })`); a raw `await fetch()` breaks the ambient scope, so wrap external async in an effect.
  - **Devtools inspector now works outside the browser (e.g. React Native).** The WebSocket relay transport is no longer gated behind `window`, so it runs anywhere `WebSocket` exists. Non-browser hosts (React Native, workers, Node) can now reach the inspector by pointing `inspectorUrl` at the `virentia-inspector` relay. `installVirentiaDevtools` also accepts a `transport` option to plug in a custom `RelayTransport`. New export `createWebSocketTransport(url, options?)` — a ready-made, runtime-agnostic WebSocket transport (auto-reconnect + buffering; accepts an injected `webSocket` constructor for environments without a global one). `createRelayTransport` is also exported.
  - **Actionable "Scope is required" errors.** These errors now name the offending unit (e.g. `Scope is required to call event "submitted"`) and explain how to provide a scope (`allSettled`, `scoped`, or a component's scope Provider). When the failing call happens inside a running handler, the error also prints the chain of units that led to it (`Unit path that led here: reaction "…" → event "…"`) so the point where the scope was lost is easy to trace.
  - **Fix:** a pre-existing leak where `scoped(scope, () => asyncFx())` left an ambient scope installed after the effect resolved. The async tail of a detached `run()` now resets the ambient scope to its neutral state.
  - **Fix:** a reentrant async effect wiping the ambient scope of its synchronous caller. When an async effect (or any async node) was triggered from inside another unit's handler, it ran through the kernel's reentrant `run()` branch, which — unlike the top-level one — did not restore the caller's scope after the node synchronously nulled the active scope. The next unit call in the same handler then failed with "Scope is required" (surfacing as an uncaught promise rejection). The reentrant branch now restores `currentPage`/`activeScope` in a `finally`.

## 0.3.1

### Patch Changes

- fix: react strict mode, unref stores and type fails

## 0.3.0

### Minor Changes

- v0.3.0

## 0.2.1

### Patch Changes

- feat: effect abortation waterflow & inspector key units

## 0.2.0

### Minor Changes

- feat: inspector, react controlled models and devtools

## 0.1.1

### Patch Changes

- fix: react & types

## 0.1.0

### Minor Changes

- feat: first release
