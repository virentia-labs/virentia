# @virentia/core

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
  - A dev warning is emitted when an auto `reaction(fn)` body returns a promise, since dependencies read after the first `await` are not tracked — use one of the async forms instead.
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
