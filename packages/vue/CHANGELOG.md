# @virentia/vue

## 0.2.7

### Patch Changes

- fix: scoped & remove allSettled
- Updated dependencies
  - @virentia/core@0.6.1

## 0.2.6

### Patch Changes

- 4e60166: Move low-level unit-building primitives to a new `@virentia/core/internal` subpath.

  Authoring custom units and stores needs the kernel and reactive plumbing that app code should not touch. That surface now lives at `@virentia/core/internal`: `createNode`, `run`, `createContext`, `withContexts` (moved off the main entry), plus the newly exposed `trackNode`, `collectNodes`, `requireActiveScope`/`setActiveScope`/`getActiveScope`, and the transaction lifecycle (`enterTransaction`, `exitTransaction`, `withTransaction`, `commitActiveTransaction`, `writeTransactionStore`, `readTransactionStore`, and the `StoreTransactionTarget`/`StoreCommitResult` types). Kernel **types** (e.g. `Node`) remain on the main entry, since every unit exposes `.node`.

  The subpath is built into the same shared chunk as the main entry, so a package that imports it (with `@virentia/core` and `@virentia/core/internal` kept external) shares core's single transaction/scope/graph state rather than getting its own copy.

  Migration: if you imported `createNode`, `run`, `createContext`, or `withContexts` from `@virentia/core`, import them from `@virentia/core/internal` instead. App code using stores/events/effects/reactions is unaffected.

- Updated dependencies [1f56652]
- Updated dependencies [4e60166]
- Updated dependencies [4e60166]
- Updated dependencies [4e60166]
  - @virentia/core@0.6.0

## 0.2.5

### Patch Changes

- Updated dependencies [ab564fc]
- Updated dependencies [e717f00]
  - @virentia/core@0.5.0

## 0.2.4

### Patch Changes

- Updated dependencies [bc209b9]
  - @virentia/core@0.4.2

## 0.2.3

### Patch Changes

- Updated dependencies [d810688]
  - @virentia/core@0.4.1

## 0.2.2

### Patch Changes

- Updated dependencies [7cb0c7e]
  - @virentia/core@0.4.0

## 0.2.1

### Patch Changes

- fix: react strict mode, unref stores and type fails
- Updated dependencies
  - @virentia/core@0.3.1

## 0.2.0

### Minor Changes

- v0.3.0
- deec3b2: Add `@virentia/vue` — Vue 3 bindings mirroring `@virentia/react`: `useUnit`, `ScopeProvider`/`provideScope`/`useProvidedScope`, `useModel`, `createModelCache`, and the `component` factory (with `.create()` and controlled models).

### Patch Changes

- Updated dependencies
  - @virentia/core@0.3.0
