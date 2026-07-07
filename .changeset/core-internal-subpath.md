---
"@virentia/core": minor
"@virentia/react": patch
"@virentia/vue": patch
---

Move low-level unit-building primitives to a new `@virentia/core/internal` subpath.

Authoring custom units and stores needs the kernel and reactive plumbing that app code should not touch. That surface now lives at `@virentia/core/internal`: `createNode`, `run`, `createContext`, `withContexts` (moved off the main entry), plus the newly exposed `trackNode`, `collectNodes`, `requireActiveScope`/`setActiveScope`/`getActiveScope`, and the transaction lifecycle (`enterTransaction`, `exitTransaction`, `withTransaction`, `commitActiveTransaction`, `writeTransactionStore`, `readTransactionStore`, and the `StoreTransactionTarget`/`StoreCommitResult` types). Kernel **types** (e.g. `Node`) remain on the main entry, since every unit exposes `.node`.

The subpath is built into the same shared chunk as the main entry, so a package that imports it (with `@virentia/core` and `@virentia/core/internal` kept external) shares core's single transaction/scope/graph state rather than getting its own copy.

Migration: if you imported `createNode`, `run`, `createContext`, or `withContexts` from `@virentia/core`, import them from `@virentia/core/internal` instead. App code using stores/events/effects/reactions is unaffected.
