---
"@virentia/core": patch
---

Awaiting an event now restores the caller's scope, matching effects.

`await someEvent()` inside a `scoped(...)` block left the ambient scope reset to `null` once the event's reactions had settled — an **async** reaction in particular — so a following store read threw "Scope is required". The event callable returned the whole drain promise, whose async tail deliberately nulls the ambient scope; an effect instead returns its own settle promise, which resolves mid-drain while the scope is still installed, which is why effects already worked.

Events now restore the scope that was active when they were called (mirroring effects), so code after `await someEvent()` keeps running in the same scope. Every async-callable unit leaves the caller's scope as it found it. (A raw `await fetch()` still drops the scope — wrap external async in an effect.)
