# @virentia/effector

Compatibility with the real Effector package.

Use this package when Virentia models need to call Effector units, or existing Effector chains need to call Virentia units. It does not replace Effector.

## Install

```sh
pnpm add @virentia/effector effector @virentia/core
```

## Basic usage

```ts
import { scope, scoped } from "@virentia/core";
import { createEffectorCompatibility } from "@virentia/effector";
import { allSettled, fork } from "effector";

const effector = createEffectorCompatibility();
const virentiaScope = scope();
const effectorScope = fork();

const association = effector.associate({
  virentia: virentiaScope,
  effector: effectorScope,
});
```

A Virentia scope and an Effector scope are required. The association is only a disposable link between them.

## Links

```ts
effector.link(virentiaSubmitted, effectorSubmitted, ({ id }) => id);

await scoped(virentiaScope, () =>
  allSettled(effectorSubmitted, {
    scope: effectorScope,
    params: "user:1",
  }),
);
```

The association is only a lifetime handle. Use `scoped`, Effector `allSettled`, `scopeBind`, or UI Providers to choose scopes.

## Effector sample

```ts
import { sample } from "effector";

sample({
  clock: effectorUserClicked,
  source: $session,
  fn: (session, userId) => ({ userId, token: session.token }),
  target: effector.asEffector(virentiaUserOpened),
});
```

## Tests

```sh
pnpm --filter @virentia/effector test
```

## License

MIT © 2026 movpushmov
