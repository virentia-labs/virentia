---
"@virentia/core": patch
"@virentia/mutable": patch
---

A store write made inside an auto-reaction body now notifies subscribers with the real scope the change happened in.

An auto-reaction (`reaction(fn)`, with or without `scope:`) runs its body with a per-run micro-scope installed as the ambient scope — a tracking overlay that shares the real scope's maps by reference but has its own identity. The store write path captured that micro-scope verbatim, so the value committed into the right scope while `store.subscribe((value, scope) => …)` received a scope that fails an identity comparison against it. Scope-filtering consumers — `useUnit` in `@virentia/react` and `@virentia/vue` compares scopes with `===` — silently dropped such updates: a component mirroring a store written from an auto-reaction never re-rendered on the change and only caught up when something else re-rendered it. Explicit `on:` reactions were unaffected.

Writes (and reads of transaction-pending values) now unwrap the micro-scope to the real scope, the same way events and effects already did at capture. `@virentia/mutable` had the same flaw in its draft/commit path and is fixed the same way; `unwrapMicroScope`/`isMicroScope` are now exported from `@virentia/core/internal` so custom stores can uphold the same rule.
