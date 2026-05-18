# @virentia/react

React bindings for Virentia core models.

Keep business logic in `@virentia/core`; use this package at the rendering boundary. Stores become render values, events and effects become callbacks bound to the provided scope.

## Links

- Documentation: [movpushmov.dev/virentia/react](https://movpushmov.dev/virentia/react/)

## Install

```sh
pnpm add @virentia/react
```

## ScopeProvider

```tsx
import { scope } from "@virentia/core";
import { ScopeProvider } from "@virentia/react";

const appScope = scope();

export function App() {
  return (
    <ScopeProvider scope={appScope}>
      <Routes />
    </ScopeProvider>
  );
}
```

## useUnit

```tsx
import { useUnit } from "@virentia/react";
import { counterModel } from "./counter.model";

export function CounterButton() {
  const count = useUnit(counterModel.count);
  const incremented = useUnit(counterModel.incremented);

  return <button onClick={() => incremented(1)}>{count}</button>;
}
```

## component

`component` pairs a model factory with a view. The model receives lifecycle units and props through `ModelContext`; the view receives an unwrapped model.

```tsx
import { event, reaction, store } from "@virentia/core";
import { component, type ModelContext } from "@virentia/react";

function createCounterModel({ props }: ModelContext<{ step: number }>) {
  const clicked = event<void>();
  const count = store(0);

  reaction({
    on: clicked,
    run() {
      count.value += props.step;
    },
  });

  return { clicked, count };
}

export const Counter = component({
  model: createCounterModel,
  view({ model }) {
    return <button onClick={() => model.clicked()}>{model.count}</button>;
  },
});
```

`component` also exposes `.create()` and accepts a `model` prop for controlled usage.
The created model owns its scope and should be disposed by the caller.

```tsx
const Parent = component({
  model() {
    const counter = Counter.create({ step: 2 });

    return { counter };
  },

  view({ model }) {
    return <Counter step={2} model={model.counter} />;
  },
});
```

## Model Caches

Use `createModelCache` when a model should survive unmount and be reused by key: chats, tabs, detail screens, media players, or previews.

```ts
import { createModelCache } from "@virentia/react";

const chatCache = createModelCache<string, ChatProps, ChatModel>();
```

## Main API

`ScopeProvider`, `useProvidedScope`, `useUnit`, `useModel`, `component`, `createModelCache`.

## License

MIT © 2026 movpushmov
