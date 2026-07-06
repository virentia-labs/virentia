---
"@virentia/core": patch
---

Reactions are global by default; per-scope binding is opt-in via `scope:`.

0.4.0 inferred per-scope binding from the scope that happened to be active when a reaction was created (`scoped(scope, () => reaction(...))`). That relied on the ambient `activeScope` global — fragile and non-deterministic, since the same model factory would behave differently depending on where it was called. A reaction with no `scope:` is now global: it re-runs whenever a store it read changes in **any** scope, reading that firing scope's value. Pass `scope:` to bind a reaction to specific scopes and isolate its automatically tracked dependencies per scope. Async dependency tracking still happens in the concrete scope each run fires in.

Migration: if you relied on a reaction created under `scoped(scope, …)` reacting only to that scope, pass `scope:` explicitly (`reaction({ scope, run })`).
