# @virentia/mutable

A store for [`@virentia/core`](https://github.com/virentia-labs/virentia) whose `.value` is a **deeply mutable object** — mutate it in place, no immutable ceremony, no dependencies.

## Links

- Documentation: [movpushmov.dev/virentia/mutable](https://movpushmov.dev/virentia/mutable/)

## Install

```sh
pnpm add @virentia/mutable
```

```ts
import { computed, event, reaction } from "@virentia/core";
import { mutableStore } from "@virentia/mutable";

const itemAdded = event<Item>();

const cart = mutableStore({ items: [] as Item[], total: 0 });
const itemCount = computed(() => cart.value.items.length);

reaction({
  on: itemAdded,
  run(item) {
    cart.value.items.push(item); // mutate in place — nested objects & arrays
    cart.value.total += item.price;
  },
});
```

Reading `.value` registers a dependency **per keypath**, so a `computed`, automatic reaction, or `map` re-runs only when a part it actually read is mutated (see [Granular reactivity](#granular-reactivity)). Each scope keeps its own value (see [Scope rules](https://movpushmov.dev/virentia/core/scopes#scope-rules)).

Only plain objects and arrays are tracked deeply; `Date`, `Map`, `Set`, and class instances are **leaves** — replace them wholesale.

## Benchmarks

ops/sec (higher is better), reproducible with `pnpm bench` — repeated deep updates to a 50 000-item array with a growing number of items changed per update. `@virentia/mutable` mutates the scope's owned nodes in place (no tree copy), so it comes out ahead of both:

| items changed (of 50 000) | immer | mutative | **@virentia/mutable** |
| --- | ---: | ---: | ---: |
| 1 000 | 276 | 1,290 | **3,033** |
| 5 000 | 121 | 277 | **571** |
| all | 17 | 24 | **53** |

Cases are defined in [`tests/cow.bench.ts`](https://github.com/virentia-labs/virentia/blob/main/packages/mutable/tests/cow.bench.ts); numbers vary by workload and machine.

## API

- `mutableStore(initial)` → `MutableStore<T>`: `.value` (get: mutable draft; set: replace wholesale), `.node`, `.subscribe(fn)`, `.map(fn)`.
- `seedMutableStore(scope, store, value)` — seed a scope's value (tests, SSR).
- `unwrap(value)` — the raw object behind a mutable proxy.

## Granular reactivity

The draft tracks reads by **keypath**. A `computed`, `map`, or automatic reaction subscribes only to the paths it actually read, so mutating one branch re-runs only the readers of that branch — the fine-grained behavior a plain `store` gets from structural sharing, but with in-place mutation.

```ts
const cart = mutableStore({ items: [] as Item[], coupon: null as string | null });

const count = computed(() => cart.value.items.length);
const coupon = computed(() => cart.value.coupon);

cart.value.items.push(item);
// Re-runs `count` only — `coupon` never read `items`, so it stays put.
```

The rule is "what you read is what you depend on". Reading `cart.value.items[3].text` subscribes to `items`, `items[3]`, and `items[3].text`: a later `cart.value.items[3].text = "…"` re-runs that reader, while an edit to `items[4]` does not.

`map` and automatic reactions follow the same rule — they read `.value` through the same draft:

```ts
const total = cart.map((c) => c.items.reduce((sum, item) => sum + item.price, 0));

reaction(() => {
  // Reads `coupon` only → re-runs only when the coupon changes.
  banner.value = cart.value.coupon ? "Discount applied" : "";
});
```

In a component, subscribe to a slice with `map`/`computed` so it re-renders granularly — see [React](https://movpushmov.dev/virentia/react/use-unit#mutable-stores) and [Vue](https://movpushmov.dev/virentia/vue/use-unit#mutable-stores).

Two reads are deliberately **coarse**, because they depend on the whole value rather than a slice:

- `unwrap(cart.value)` takes the raw object, so it depends on _any_ change.
- `store.subscribe(...)` and `useUnit(store)` on the whole store read the entire value, so they re-fire on every commit.

## When to use it

Reach for a mutable store for state you **edit in place, deeply, and often** — a form, a rich-text or canvas document, a large table you patch cell by cell. Writing

```ts
doc.value.blocks[3].items[7].text = "hello";
```

is simpler than rebuilding that path by hand, and derivations stay [granular](#granular-reactivity): only readers of `blocks[3].items[7].text` re-run.

Two things to keep in mind, both a consequence of mutating in place:

- **Identity is not stable.** `cart.value` mutates in place, so its object reference can be unchanged before and after a write. Don't compare snapshots with `===` to detect a change — depend on the parts you read, or use a plain `store` when you need value identity.
- **Whole-value subscribers are coarse.** `store.subscribe` and `useUnit(store)` read the entire value and re-fire on every commit. Subscribe to a slice with `map`/`computed` when a consumer needs only part of the state.

For flat state you mostly replace rather than deeply edit, a plain [`store`](https://movpushmov.dev/virentia/core/stores) or [`reactive`](https://movpushmov.dev/virentia/core/stores#reactive-stores) is simpler and gives stable value identity.

## Under the hood

This section explains how the mutable store works below the API. You do not need it to use the package — it is here for when you are debugging or curious about the cost model.

### The value is a copy-on-write draft

Reading `.value` returns a `Proxy` over the scope's current committed object — a _draft_. While you only read, the draft forwards every access to the underlying object; nothing is copied and the committed value is untouched.

The first time you write into a node, the draft shallow-copies **only that node** and threads the copy up its parent chain, so each ancestor points at the new child. Sibling branches you did not touch keep their original reference. There is no `structuredClone` and no full snapshot — this is the copy-on-write that immer and mutative also use.

Because the draft's write target is a real array/object, `length`, indices, and enumeration behave correctly, and `push`/`splice`/`sort` run as native array methods on the copy.

### Ownership: mutate in place after the first divergence

A store is mutated over and over, so re-copying the same nodes on every update would be wasteful. Each scope remembers the nodes it has already copied (its _owned_ set). A write into an owned node mutates it **in place** — no new copy — while a write into a still-shared node (equal to the default or a previous committed value) copies it once, then owns it.

This is the difference from immer and mutative, which produce a fresh immutable value on every call. It is why the benchmarks favor the mutable store: after the first change to a path, later changes to it are plain in-place assignments.

An object _you_ assign into the tree is treated as shared, not owned: descending into it and mutating copies it first, so the object you passed in is never mutated.

### Commit at the transaction boundary

The draft is not committed while you mutate it, and each write records the keypath it changed. On the transaction boundary — immediately for a plain `scoped(...)` change, or batched at the end of a reaction/effect (see [Transactions](https://movpushmov.dev/virentia/core/transactions)) — the draft's latest tree is written into the scope and the changed paths are notified. Because an in-place mutation can leave the object identity unchanged, notification is _forced_ rather than gated on `Object.is`: the store fires the graph nodes for the changed keypaths (plus one coarse node for whole-value subscribers), so a reader re-runs exactly when a path it read was written.

The store is a real graph node built on `@virentia/core/internal`, so `reaction`, `computed`, `subscribe`, and `map` observe it like any store, and per-scope values, seeding, and cleanup work as usual.

### Keypath tracking

While a reader is collecting dependencies — a `computed` evaluating, an automatic reaction running — each proxy read reports the keypath it touched, and the store maps that path to a lazily-created graph node the reader subscribes to. A read reports every prefix of the path (a get walks parent→child), so replacing an ancestor invalidates deep readers; a write reports only the exact path, so a sibling edit does not. Outside a tracking window — an ordinary mutation — the read hooks do nothing, which is why the write path stays as fast as mutating a plain object.

### Leaves

Only plain objects and arrays are drafted. `Date`, `RegExp`, `Map`, `Set`, and class instances are leaves: reads return them raw, and you replace them wholesale (`state.value.when = new Date()`). Mutating _into_ a leaf (`state.value.when.setHours(0)`) is not tracked.

### Why it is fast

Each changed node is one small state object (a class, for a stable shape) plus one `Proxy` — no per-node closures and no side lookup tables. Nodes you do not touch cost nothing (proxies are created lazily, on access). Committing mutates in place, and there is no finalize or freeze pass — immer freezes its result by default, which dominates its cost.

## License

MIT © 2026 movpushmov
