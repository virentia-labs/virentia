# @virentia/effector

Effector-compatible facade powered by `@virentia/core`.

`@virentia/effector` is for projects that already use the Effector public API and want to run that model layer on Virentia primitives with a small, explicit migration.

<p>
  <img alt="Runnable upstream tests" src="https://img.shields.io/badge/runnable%20upstream-100%25%20passing-2ea44f?style=flat-square">
  <img alt="User facing coverage" src="https://img.shields.io/badge/user--facing%20coverage-97.85%25-2ea44f?style=flat-square">
  <img alt="Failures" src="https://img.shields.io/badge/failures-0-success?style=flat-square">
  <img alt="License" src="https://img.shields.io/badge/license-MIT-blue?style=flat-square">
</p>

## Why You Can Trust It

The compatibility layer is tested against the upstream Effector test suite after rewriting imports to `@virentia/effector` and running the official `effector/babel-plugin` with `@virentia/effector` enabled.

| Signal                      |                    Result | What it means                                                                                                                      |
| --------------------------- | ------------------------: | ---------------------------------------------------------------------------------------------------------------------------------- |
| 🟢 Runnable upstream tests  |       `409 / 409` passing | Every test that is currently part of the runnable compatibility contract passes.                                                   |
| 🟢 Failed tests             |                       `0` | There are no known failing tests hidden behind the status number.                                                                  |
| 🟢 User-facing API coverage |                  `97.85%` | Public API behavior that matters to application code is almost fully covered.                                                      |
| 🟡 Full upstream diagnostic | `409 / 668` tests passing | The rest is mostly skipped because it checks Effector internals, exact graphite shape, debug stacks, or eager scheduler snapshots. |
| 🟢 Remaining important gaps |                 `9` tests | The remaining user-facing gaps are tracked and intentionally narrow.                                                               |

> [!IMPORTANT]
> This package is not trying to clone Effector's internal graphite kernel. It focuses on the public API surface that application code and ecosystem libraries normally depend on.

## Compatibility Scope

| Area                           | Status                 | Notes                                                                                                                               |
| ------------------------------ | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Events and stores              | ✅ Stable              | `createEvent`, `createStore`, `.on`, `.reset`, `.watch`, `.map`, `.updates`.                                                        |
| Effects                        | ✅ Stable              | `createEffect`, `.use`, lifecycle units, `pending`, `inFlight`, scoped handlers.                                                    |
| Derived graph operators        | ✅ Stable              | `sample`, `combine`, `guard`, `split`, `merge`, `restore`, `createApi`.                                                             |
| Scopes                         | ✅ Stable              | `fork`, `allSettled`, `serialize`, `hydrate`, `scopeBind` for the common sync and unit-binding flows.                               |
| Domains and regions            | ✅ Covered             | Domain hooks/history, nested domains, domain-backed ownership, `withRegion`, `clearNode`.                                           |
| Serialization                  | ✅ Covered             | Explicit SID serialization, `serialize: "ignore"`, custom read/write, `onlyChanges: true`.                                          |
| `skipVoid` compatibility       | ✅ Covered             | `createStore`, `store.map`, and `combine` runtime/config behavior is supported.                                                     |
| Babel naming and SIDs          | 🟡 Partial             | The official Effector Babel plugin works with `@virentia/effector`, but exact SID/hash/debug-stack agreement is not a contract.     |
| Exact eager ordering snapshots | 🟡 Different by design | Virentia has lazy computation semantics; final state compatibility is prioritized over Effector's intermediate scheduler snapshots. |

## Remaining Known Gaps

These are the remaining user-facing gaps after the current upstream pass:

| Gap                                     | Count | Why it remains                                                                                                                                                       |
| --------------------------------------- | ----: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `attach` lifecycle ordering             |   `5` | Effector checks exact watcher/sample priority around attached effects. Virentia keeps the runtime contract, but does not promise identical intermediate flush order. |
| Async `scopeBind` propagation           |   `3` | Needs a deliberate decision on async context propagation across arbitrary awaited callbacks.                                                                         |
| Nested awaited `allSettled` transaction |   `1` | Depends on reentrant async effect flushing semantics.                                                                                                                |

## What Is Intentionally Out Of Scope

| Skipped category                       | Why it is skipped                                                                                  |
| -------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Effector graphite/kernel internals     | Virentia has its own graph and ownership model.                                                    |
| Exact debug/error stack formatting     | Useful for Effector itself, but not a portable runtime contract.                                   |
| Hidden DI hooks                        | Internal Effector extension points are not part of normal app code.                                |
| Observable protocol interop            | Not required for the current facade contract.                                                      |
| Factory SID hash snapshots             | The Babel plugin is supported, but exact Effector hash snapshots are not promised.                 |
| Eager scheduler intermediate snapshots | Virentia's lazy model can produce the same useful result without the same intermediate call order. |

## Target Ecosystem

The goal is that projects can move typical Effector-shaped application code and ecosystem packages with minimal friction. These packages are treated as priority compatibility targets:

| Package                                           | Target                                                         |
| ------------------------------------------------- | -------------------------------------------------------------- |
| `patronum`                                        | Common store/event helpers and previous-value style utilities. |
| `farfetched`                                      | Effect-heavy async data flows.                                 |
| `@argon-router/core`, `@argon-router/react`       | Routing models and React integration.                          |
| `@effector-reform/core`, `@effector-reform/react` | Form models and bindings.                                      |
| `@effector-kit/models`, `@effector-kit/react`     | Factory/model composition patterns.                            |
| `effector-action`                                 | Action helpers over Effector units.                            |
| `effector-storage`                                | Serialization and persistence flows.                           |

## Install

```sh
pnpm add @virentia/effector
```

## Migration From Effector

Prefer an explicit import replacement instead of package aliasing:

```diff
- import { createEvent, createStore } from "effector";
+ import { createEvent, createStore } from "@virentia/effector";
```

This keeps your dependency graph honest: libraries that still need the real `effector` package can keep using it, while your application code can migrate intentionally.

If the project uses the official `effector/babel-plugin`, keep it and add `@virentia/effector` to the same import/factory configuration:

```js
module.exports = {
  plugins: [
    [
      "effector/babel-plugin",
      {
        importName: ["effector", "@virentia/effector"],
        factories: [
          "@virentia/effector",
          "patronum",
          "farfetched",
          "@argon-router/core",
          "@effector-reform/core",
          "@effector-kit/models",
        ],
      },
    ],
  ],
};
```

## Counter

```ts
import { allSettled, createEvent, createStore, fork } from "@virentia/effector";

const incremented = createEvent<number>();
const $count = createStore(0).on(incremented, (count, amount) => count + amount);

const appScope = fork();

await allSettled(incremented, {
  scope: appScope,
  params: 2,
});

console.log(appScope.getState($count)); // 2
```

## Effects

```ts
import { allSettled, createEffect, fork } from "@virentia/effector";

const loadUserFx = createEffect<string, { id: string; name: string }>(async (id) => {
  const response = await fetch(`/api/users/${id}`);
  return response.json();
});

const appScope = fork({
  handlers: [[loadUserFx, async (id) => ({ id, name: "Ada" })]],
});

const result = await allSettled(loadUserFx, {
  scope: appScope,
  params: "user:1",
});

console.log(result.status); // "done"
```

Effects expose Effector-shaped lifecycle units: `done`, `fail`, `finally`, `doneData`, `failData`, `pending`, and `inFlight`.

## Main API

`createEvent`, `createStore`, `createEffect`, `createDomain`, `sample`, `combine`, `guard`, `split`, `merge`, `forward`, `createApi`, `restore`, `attach`, `fork`, `allSettled`, `serialize`, `hydrate`, `scopeBind`, `withRegion`, `clearNode`, `step`, `is`.

## Test Command

```sh
pnpm --filter @virentia/effector test:upstream
```

Current diagnostic result:

```txt
409 passed / 259 skipped / 0 failed / 668 total
```

Skipped tests are counted explicitly and are not treated as hidden passes.

## License

MIT © 2026 movpushmov
