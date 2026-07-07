# @virentia/mutable

A store for [`@virentia/core`](https://github.com/virentia-labs/virentia) whose `.value` is a **deeply mutable object** — mutate it in place, no immutable ceremony, no dependencies.

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

Reading `.value` registers a dependency, so `computed`, auto reactions, `subscribe`, and `map` react to mutations. Each scope keeps its own value.

## How it works — copy-on-write, no `structuredClone`

`.value` hands out a **copy-on-write draft** over the scope's current value:

- The original committed value is **never touched** before commit.
- On the first write into a node, only **that node** is shallow-copied; untouched branches stay **shared by reference** (no `structuredClone`, no snapshots).
- Nodes the scope already owns (copies it made in an earlier commit) are **mutated in place** instead of copied again.
- An object you assign into the tree is not mutated either — descend-and-mutate copy-on-writes it, leaving your object intact.
- At the **transaction boundary** (immediately for a plain `scoped(...)` mutation, batched inside a reaction/effect) the draft becomes the scope's value and a notification re-runs everything that read the store.

Because a draft node's Proxy target is the real object, array `length`/index and enumeration invariants hold and **array mutators (`push`, `splice`, `sort`, …) run natively**.

Only plain objects and arrays are tracked deeply; `Date`, `Map`, `Set`, and class instances are **leaves** — replace them wholesale.

## Benchmarks

ops/sec (higher is better), reproducible with `pnpm bench` — repeated deep updates to a 50 000-item array with a growing number of items touched. `@virentia/mutable` mutates the scope's owned nodes in place (no tree copy), so it comes out ahead of both:

| items touched (of 50 000) | immer | mutative | **@virentia/mutable** |
| --- | ---: | ---: | ---: |
| 1 000 | 276 | 1,290 | **3,033** |
| 5 000 | 121 | 277 | **571** |
| all | 17 | 24 | **53** |

The margin comes from mutating touched nodes in place instead of copying the tree, one small state class + Proxy per touched node (no per-node closures, no side maps), and no finalize/freeze pass — immer auto-freezes, which dominates its cost. Numbers vary by workload and machine.

## API

- `mutableStore(initial)` → `MutableStore<T>`: `.value` (get: mutable draft; set: replace wholesale), `.node`, `.subscribe(fn)`, `.map(fn)`.
- `seedMutableStore(scope, store, value)` — seed a scope's value (tests, SSR).
- `unwrap(value)` — the raw object behind a mutable proxy.

## Trade-off

Stable-per-scope value with a forced notification means reactivity is **coarse**: any commit invalidates every reader of the store (it can't tell which sub-branch changed by reference). Reach for this when you want ergonomic in-place mutation of large or nested state (editors, forms, documents). For fine-grained, structural-sharing reactivity, use a plain immutable `store` and derive with `computed`.
