# @virentia/core

Core package for Virentia state models.

Use it to describe business state without depending on React, routing, or any other UI layer. A model is built from small primitives:

- stores remember values;
- events name facts or domain intents;
- effects run external async work;
- reactions describe rules between stores, events, and effects;
- scopes hold concrete values for one app, request, test, widget, or cached screen;
- owners define cleanup boundaries for runtime models.

## Links

- Documentation: [movpushmov.dev/virentia/core](https://movpushmov.dev/virentia/core/)

## Install

```sh
pnpm add @virentia/core
```

## Counter

```ts
import { allSettled, event, reaction, scope, scoped, store } from "@virentia/core";

export function createCounterModel() {
  const incremented = event<number>();
  const count = store(0);

  reaction({
    on: incremented,
    run(amount) {
      count.value += amount;
    },
  });

  return { count, incremented };
}

const model = createCounterModel();
const appScope = scope();

await allSettled(model.incremented, {
  scope: appScope,
  payload: 1,
});

scoped(appScope, () => {
  console.log(model.count.value);
});
```

## Runtime Cleanup

`owner` groups reactions, subscriptions, and cleanup callbacks created at runtime. The returned model root gets `dispose()` and `[Symbol.dispose]()` when it is an object.

```ts
import { event, onCleanup, owner, reaction, store } from "@virentia/core";

export function createDraftModel() {
  return owner(() => {
    const changed = event<string>();
    const text = store("");
    const timer = setInterval(() => {}, 1000);

    reaction({
      on: changed,
      run(value) {
        text.value = value;
      },
    });

    onCleanup(() => {
      clearInterval(timer);
    });

    return { changed, text };
  });
}

const draft = createDraftModel();

draft.dispose();
```

`using` can be used in runtimes or build pipelines that support Explicit Resource Management. Plain `model.dispose()` is the safe baseline.

## Main API

`scope`, `scoped`, `store`, `computed`, `event`, `effect`, `attach`, `reaction`, `allSettled`, `owner`, `onCleanup`, `getOwner`, `withOwner`, `lazyModel`, `createNode`, `run`, `createContext`, `withContexts`.

## License

MIT © 2026 movpushmov
