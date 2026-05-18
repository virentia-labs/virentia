# Getting Started

Install the package that owns your state model first:

```sh
pnpm add @virentia/core
```

Add `@virentia/react` only when you render models in React. Add `@virentia/effector` only when Virentia models need to work with existing Effector models.

## Small Model

Start with the state your feature must remember, then name the events that change it. In a counter, the state is the current number. The events are `incremented` and `reset`: the count was increased, or the counter was reset.

```ts
import { event, reaction, store } from "@virentia/core";

export function createCounterModel() {
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
```

The important part is the split of responsibility. Stores remember. Events describe what happened. Reactions hold the rules that connect events to state changes. Keeping those roles separate makes the model easier to extend than a single object with a pile of setters.

## State In A Scope

A model definition is reusable. A scope stores values for a concrete instance: an app, a test, a server request, or a cached screen.

```ts
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

Use `allSettled` when you need to explicitly run an event or effect in a specific scope: in a test, server loader, command, or adapter. Use `scoped(scope, fn)` when plain code must read or write stores, including after `await`. If another library will call your callback later, keep it with `scoped(scope).wrap(fn)`.

## UI Libraries

A model written with `@virentia/core` does not depend on the UI layer. Read [`@virentia/react`](/react/) to connect it to React. Other UI adapters should follow the same shape: the UI chooses a scope, while the model stays plain Virentia code.

## Next Sections

Read [Ideology](/guide/ideology) before the API pages. It explains why Virentia separates stores, events, effects, reactions, scopes, and owners.
