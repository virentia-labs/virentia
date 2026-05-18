# Effector compatibility

`@virentia/effector` lets Virentia models work with applications that already use Effector.

Existing Effector code keeps importing from `effector`; Virentia models keep importing from `@virentia/core`. This package connects their scopes and forwards calls between units.

## Install

```sh
pnpm add @virentia/effector effector @virentia/core
```

## Create compatibility

Create the compatibility object once and keep it for the application lifetime:

```ts
import { createEffectorCompatibility } from "@virentia/effector";

export const effector = createEffectorCompatibility();

effector.link(virentiaSubmitted, effectorSubmitted, ({ id }) => id);
```

Isolation lives in an association between a Virentia scope and an Effector scope:

```ts
import { scope } from "@virentia/core";
import { fork } from "effector";

const association = effector.associate({
  virentia: scope(),
  effector: fork(),
});
```

Effector units remain the same objects. `fork()` only creates isolated value storage for SSR, tests, and other boundaries. When an adapter runs inside the Effector graph, `@virentia/effector` reads the Effector scope from `stack.scope` and uses it to find the associated Virentia scope.

Both scopes are required. If code tries to use compatibility helpers without an association, it throws instead of creating a hidden scope.

The association does not call units by itself and does not participate in application execution. It only registers the scope pair and gives you a `dispose()` handle. Run code with the native tools of both runtimes:

```ts
await scoped(virentiaScope, () =>
  allSettled(effectorSubmitted, {
    scope: effectorScope,
    params: "user:1",
  }),
);
```

In this run, the Virentia scope comes from `scoped`, and the Effector scope comes from `allSettled`. The compatibility layer only checks that this pair was associated.

## Effector operators

Virentia units can be used inside real Effector operators:

```ts
import { sample } from "effector";

sample({
  clock: effectorUserClicked,
  source: $session,
  fn: (session, userId) => ({
    userId,
    token: session.token,
  }),
  target: effector.asEffector(virentiaUserOpened),
});
```

The wrapper is a normal Effector unit. Target support is still checked through `is.targetable`.

## SSR

Create one association per request and dispose it after rendering:

```ts
import { allSettled, fork } from "effector";
import { scope, scoped } from "@virentia/core";

const virentiaScope = scope();
const effectorScope = fork();
const association = effector.associate({
  virentia: virentiaScope,
  effector: effectorScope,
});

try {
  await scoped(virentiaScope, () =>
    allSettled(appStarted, {
      scope: effectorScope,
      params: request,
    }),
  );
} finally {
  association.dispose();
}
```

Use Virentia snapshot tools for the Virentia scope and `serialize` from Effector for the Effector scope. The compatibility layer only remembers which scopes belong together.

## Where the Effector scope comes from

`@virentia/effector` does not try to discover a “current scope” from arbitrary Effector calls. The scope is available only while the Effector graph is executing.

The adapter is a real Effector unit with a child node built on `step.run`. That step receives `stack`, reads `stack.scope`, and looks up an existing association. If Effector is launched without `fork`, `stack.scope` is empty; there is no isolated Effector scope to recover.

Virentia-to-Effector adapters take the Effector scope from the association of the current Virentia scope and use `launch({ target, params, scope })`. If there is no pair, that is an integration error.
