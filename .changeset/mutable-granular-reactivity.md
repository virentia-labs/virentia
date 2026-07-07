---
"@virentia/mutable": minor
"@virentia/core": minor
---

`@virentia/mutable`: fine-grained, per-keypath reactivity — no API change.

A `computed`, auto reaction, or `map` over a mutable store now re-runs only when a keypath it actually read is written. Mutating one branch no longer re-runs readers of unrelated branches:

```ts
const cart = mutableStore({ items: [] as Item[], coupon: null as string | null });
const count = computed(() => cart.value.items.length);
const coupon = computed(() => cart.value.coupon);

cart.value.items.push(item);
// Re-runs `count` only — `coupon` never read `items`.
```

The draft proxy reports each read keypath (with every prefix, so replacing an ancestor still invalidates deep readers) and each written keypath; the store maps keypaths to graph nodes and, at commit, fires only the nodes whose paths changed. `unwrap(store.value)` takes a coarse dependency (any change), and `store.subscribe` / `useUnit(store)` on the whole value stay coarse by definition. Tracking runs only while a reader is collecting dependencies, so the write path — and its benchmark lead over mutative and immer — is unchanged.

`@virentia/core`: `@virentia/core/internal` now exports `isTracking()`, so a custom store can tell whether a read should register as a dependency.
