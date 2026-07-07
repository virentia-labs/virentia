---
"@virentia/mutable": minor
---

New package: a store for `@virentia/core` whose `.value` is a deeply mutable object.

`mutableStore(initial)` hands out a **copy-on-write draft** as `.value`, so you mutate state in place — `state.value.a.items.push(x)`, `state.value.count++`, `delete state.value.a.flag`. No `structuredClone`, no stored snapshots: the original committed value is untouched before commit, only touched nodes are shallow-copied, untouched branches stay shared by reference, and nodes the scope already owns are mutated in place. At the transaction boundary the draft becomes the scope's value with a forced notification, so `computed`, auto reactions, `subscribe`, and `map` react. Array mutators run natively (the Proxy target is the real object); `Date`, `Map`, `Set`, and class instances are leaves. Each scope keeps its own value; `seedMutableStore(scope, store, value)` seeds one.

Built on the new `@virentia/core/internal` primitives, with no runtime dependencies. Because only touched nodes are proxied and copied, it benchmarks several times faster than mutative and immer when updating a small part of the state (the common case) and stays competitive when touching everything at once.
