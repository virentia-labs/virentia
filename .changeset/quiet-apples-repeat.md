---
"@virentia/core": minor
---

Failure handling, disposal, and store enumeration now behave the way the docs promise.

**Observer failures follow ordinary async semantics.** A throwing reaction stops its own
branch, is reported rather than swallowed, leaves the independent branches of the same
update running, and rejects the trigger for whoever awaits it (`AggregateError` when
several branches failed). Async reactions now follow exactly the same rules as
synchronous ones — previously an async rejection was absorbed into the node's context,
propagation continued on the leftover `undefined`, and `scoped(...)` resolved as if
nothing had happened. A fire-and-forget update never becomes an unhandled rejection, so
a failing rule cannot take a Node process down.

**`setErrorReporter(fn | null)`** routes those failures to a crash reporter or a
structured logger. The callback receives a `VirentiaFailureReport` (`kind`, `unit`,
`declaredAt`, `scope`, `path`, `error`, `message`), so nothing has to be parsed out of a
string. The default console report names the failing unit, where it was declared, and the
chain of units the update travelled through.

**Owner disposal cascades.** An owner created inside another owner's body is its child and
goes down with it, innermost first. Disposal also aborts the effect calls *made under*
that owner — not only calls of effects declared inside it — so a module-scope effect
called by a screen model is cancelled when the screen is torn down.

**`lazyModel` exposes `loaded`.** `pending` reads `false` both before and after an import,
so it cannot gate a read; `loaded` can. Reading a lazy unit while `loaded` is false throws,
and the types do not stop you because `LazyModel<Model>` is typed as `Model`.

**Stores no longer leak their api into enumeration.** `Object.keys`, spread, `for...in`,
`Object.entries` and `JSON.stringify` now see the state alone. `node`, `subscribe`, `map`,
`filter`, `filterMap` and `writable` stay reachable by direct access and through `in`, but
are non-enumerable — serializing a store used to embed its inspector metadata into the
snapshot. Known limitation, unchanged: a state field named like an api member is still
shadowed by that member on read.

Also fixed: a read taken partway through an update no longer swallows a derived store's
own notification (`computed`, `.map`, `.filter` and `subscribe` alike), and
`serializeDevtoolsValue` degrades instead of throwing on a hostile getter or proxy, so
enabling devtools cannot take the app down.
