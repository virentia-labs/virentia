<p align="center">
  <img src="docs/public/logo.svg" alt="Virentia" width="112" height="112">
</p>

# Virentia

State manager for complex business logic.

Virentia helps describe application rules outside the UI: stores keep state, events name domain actions, effects run external work, and reactions connect them into behavior. The same model can be reused in an app, test, server request, widget, tab, or cached screen without sharing state.

## Links

- Documentation: [movpushmov.dev/virentia](https://movpushmov.dev/virentia)

## Packages

- `@virentia/core` — stores, events, effects, reactions, scopes, owners, lazy models, and low-level graph primitives.
- `@virentia/react` — React bindings for core models: `ScopeProvider`, `useUnit`, `useModel`, `component`, and model caches.
- `@virentia/effector` — compatibility between Virentia scopes and the real Effector runtime.

## Example

```ts
import { allSettled, event, reaction, scope, scoped, store } from "@virentia/core";

function createCounterModel() {
  const incremented = event<number>();
  const reset = event<void>();
  const count = store(0);

  reaction({
    on: incremented,
    run(amount) {
      count.value += amount;
    },
  });

  reaction({
    on: reset,
    run() {
      count.value = 0;
    },
  });

  return { count, incremented, reset };
}

const model = createCounterModel();
const appScope = scope();

await allSettled(model.incremented, {
  scope: appScope,
  payload: 2,
});

scoped(appScope, () => {
  console.log(model.count.value); // 2
});
```

## Development

```sh
pnpm install
pnpm test
pnpm typecheck
pnpm build
pnpm docs:dev
```

## Documentation

The documentation lives in `docs` and is built with VitePress.

```sh
pnpm docs:build
pnpm docs:dev
```

## License

MIT © 2026 movpushmov
