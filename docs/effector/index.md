# Effector Bridge

`@virentia/effector` is an Effector-compatible facade on top of Virentia core. It is built for projects that already have Effector-shaped models and want a direct, explicit migration path.

<div class="compat-status-grid" aria-label="Effector compatibility status">
  <div class="compat-status-card">
    <span class="compat-status-kicker"><span class="compat-status-dot"></span>Runnable upstream</span>
    <strong>100%</strong>
    <span>409 / 409 enabled tests passing</span>
  </div>
  <div class="compat-status-card">
    <span class="compat-status-kicker"><span class="compat-status-dot"></span>User-facing coverage</span>
    <strong>97.85%</strong>
    <span>public API behavior covered</span>
  </div>
  <div class="compat-status-card compat-status-card-muted">
    <span class="compat-status-kicker"><span class="compat-status-dot"></span>Known failures</span>
    <strong>0</strong>
    <span>no hidden red tests</span>
  </div>
</div>

::: tip Compatibility status
The upstream diagnostic currently reports `409 passed / 259 skipped / 0 failed / 668 total`.

The stricter user-facing coverage is `97.85%`: skipped checks that only assert Effector internals, exact debug stacks, graphite shape, observable interop, or eager scheduler snapshots are not counted as compatibility promises.
:::

## Confidence Signals

| Signal                      |              Result | Meaning                                                                            |
| --------------------------- | ------------------: | ---------------------------------------------------------------------------------- |
| 🟢 Runnable upstream tests  | `409 / 409` passing | Every enabled upstream compatibility test passes.                                  |
| 🟢 Failed tests             |                 `0` | There are no known failing tests hidden in the suite.                              |
| 🟢 User-facing coverage     |            `97.85%` | Public API behavior important to app code is almost fully covered.                 |
| 🟡 Full upstream diagnostic |            `61.23%` | The skipped part is mostly Effector internals and exact scheduler/debug snapshots. |

## What Is Covered

| Area                                                                    | Status       |
| ----------------------------------------------------------------------- | ------------ |
| Events, stores, effects                                                 | ✅           |
| `sample`, `combine`, `guard`, `split`, `merge`, `restore`, `createApi`  | ✅           |
| `fork`, `allSettled`, `serialize`, `hydrate`, common `scopeBind` flows  | ✅           |
| Domains, regions, `withRegion`, `clearNode`                             | ✅           |
| `serialize: "ignore"`, custom serialize read/write, `onlyChanges: true` | ✅           |
| `skipVoid` runtime/config behavior                                      | ✅           |
| Exact Effector graphite/debug-stack identity                            | Not promised |
| Exact eager intermediate ordering                                       | Not promised |

## Remaining User-Facing Gaps

| Gap                                      | Count |
| ---------------------------------------- | ----: |
| `attach` lifecycle ordering snapshots    |   `5` |
| Async `scopeBind` propagation edge cases |   `3` |
| Nested awaited `allSettled` transaction  |   `1` |

## Import Change

Prefer explicit imports over npm aliasing:

```diff
-import { createEvent, createStore } from "effector";
+import { createEvent, createStore } from "@virentia/effector";
```

If you use `effector/babel-plugin`, add `@virentia/effector` to the same import/factory configuration.

```js
plugins: [
  [
    "effector/babel-plugin",
    {
      importName: ["effector", "@virentia/effector"],
      factories: ["@virentia/effector", "patronum", "farfetched"],
    },
  ],
];
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

## Main Difference

Virentia keeps the Effector public surface, but it does not clone Effector's internal graphite kernel. The bridge prioritizes observable application behavior and ecosystem compatibility over exact internal graph shape.
