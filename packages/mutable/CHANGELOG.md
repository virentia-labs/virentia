# @virentia/mutable

## 0.2.0

### Minor Changes

- feat: some fixes, component mapProps & shape protocol

### Patch Changes

- Updated dependencies
  - @virentia/core@0.7.0

## 0.1.5

### Patch Changes

- feat: some fixes & fully tests coverage
- Updated dependencies
  - @virentia/core@0.6.4

## 0.1.4

### Patch Changes

- Updated dependencies
  - @virentia/core@0.6.3

## 0.1.3

### Patch Changes

- Updated dependencies
  - @virentia/core@0.6.2

## 0.1.2

### Patch Changes

- fix: scoped & remove allSettled
- Updated dependencies
  - @virentia/core@0.6.1

## 0.1.1

### Patch Changes

- chore: update readme

## 0.1.0

### Minor Changes

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

- 4e60166: New package: a store for `@virentia/core` whose `.value` is a deeply mutable object.

  `mutableStore(initial)` hands out a **copy-on-write draft** as `.value`, so you mutate state in place — `state.value.a.items.push(x)`, `state.value.count++`, `delete state.value.a.flag`. No `structuredClone`, no stored snapshots: the original committed value is untouched before commit, only touched nodes are shallow-copied, untouched branches stay shared by reference, and nodes the scope already owns are mutated in place. At the transaction boundary the draft becomes the scope's value with a forced notification, so `computed`, auto reactions, `subscribe`, and `map` react. Array mutators run natively (the Proxy target is the real object); `Date`, `Map`, `Set`, and class instances are leaves. Each scope keeps its own value; `seedMutableStore(scope, store, value)` seeds one.

  Built on the new `@virentia/core/internal` primitives, with no runtime dependencies. Because only touched nodes are proxied and copied, it benchmarks several times faster than mutative and immer when updating a small part of the state (the common case) and stays competitive when touching everything at once.

- 4e60166: Rename the low-level kernel factories to drop the `create` prefix: `@virentia/core/internal` now exports `node()` (was `createNode`) and `context()` (was `createContext`). The `CreateNodeOptions` type is now `NodeOptions`.

  This only affects code that authors custom units/stores on `@virentia/core/internal`; application code (stores/events/effects/reactions) is unchanged. Update imports:

  ```ts
  // before
  import { createNode, createContext } from "@virentia/core/internal";
  // after
  import { node, context } from "@virentia/core/internal";
  ```

### Patch Changes

- Updated dependencies [1f56652]
- Updated dependencies [4e60166]
- Updated dependencies [4e60166]
- Updated dependencies [4e60166]
  - @virentia/core@0.6.0
