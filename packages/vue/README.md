# @virentia/vue

Vue 3 bindings for [Virentia](https://movpushmov.dev/virentia). Mirrors the
`@virentia/react` API surface, adapted to Vue's reactivity and composition model.

## Install

```sh
pnpm add @virentia/vue @virentia/core vue
```

## Scope

Provide a scope to a subtree and read it from composables.

```ts
import { scope } from "@virentia/core";
import { ScopeProvider, provideScope, useProvidedScope } from "@virentia/vue";
```

- `ScopeProvider` — component that provides a scope to its slot.
- `provideScope(scope)` — same, called inside your own `setup`.
- `useProvidedScope()` — read the provided scope (throws if missing).

## useUnit

Binds units to the provided scope. Stores become reactive refs; events and
effects become callables bound to the scope.

```ts
import { useUnit } from "@virentia/vue";

export default {
  setup() {
    const count = useUnit(countStore); // Readonly<Ref<number>>
    const increment = useUnit(incremented); // (payload) => Promise<void>
    const { name, changed } = useUnit({ name: nameStore, changed }); // refs + callables

    return { count, increment, name, changed };
  },
};
```

## useModel / createModelCache

Builds a model instance, wires its lifecycle to the component, and exposes a
reactive view of the model (stores as refs, events/effects as callables).

```ts
import { useModel } from "@virentia/vue";

const model = useModel(createCounterModel, () => props);
```

Pass `{ cache, key }` (see `createModelCache`) to keep models alive across
unmounts.

## component

Pairs a model factory with a view component, mirroring `@virentia/react`'s
`component`. Supports `.create()` for child/controlled models.

```ts
import { component } from "@virentia/vue";

const Counter = component({
  model: createCounterModel,
  view: CounterView, // receives `model` (ReactiveModel) plus the model props
});
```
