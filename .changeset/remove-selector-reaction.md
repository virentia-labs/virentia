---
"@virentia/core": patch
---

Remove the `reaction(selector, effect)` overload.

It was redundant with `reaction({ on: computed(selector), run: effect })`: a `computed` already dedupes on the derived value, and an explicit `on` reaction does not run at creation — which is exactly the selector form's semantics. Dropping it trims a third signature from an already heavily overloaded `reaction`. Migrate `reaction(() => expr, fn)` to `reaction({ on: computed(() => expr), run: fn })`.
