# Core

`@virentia/core` is the base Virentia package. It describes the business state model: which data a task needs, what can happen, which async work is required, and which rules connect those parts.

A core model does not need to know where it will be rendered. It can be called from React, a test, a server handler, or background work. That is why core code should use the language of the business task rather than the language of a specific UI.

```ts
import { event, reaction, store } from "@virentia/core";

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
```

Here `count` is a store, `incremented` is an event, and `reaction` is the rule. The event says what happened. The rule decides how state changes.

## Split Responsibility

A store holds a value. An event reports a fact or a domain intent. An effect starts work that will finish later. A reaction connects those pieces into behavior.

If you are about to add a method like `setCount`, name the event in task language instead: `incremented`, `reset`, `open`, `submitted`, `messageReceived`. The model should talk about the meaning of the action, not the technical way to mutate a field.

## Value Storage

A core model can be imported once and run in many scopes. The scope holds concrete store values, so the same model can safely run in an app, a test, a server request, or a separate widget.

```ts
const first = scope();
const second = scope();
const model = createCounterModel();

await allSettled(model.incremented, { scope: first, payload: 1 });
await allSettled(model.incremented, { scope: second, payload: 10 });
```

One model, two states. That is the basic Virentia mechanism.

## What Next

Start with the main units: [stores](/core/stores), [events](/core/events), [effects](/core/effects), and [reactions](/core/reactions). Then read [Transactions](/core/transactions) to understand when writes become visible, and [Scopes](/core/scopes) to understand where values live and how `scoped` works. If models are created and removed at runtime, read [Owners and Cleanup](/core/owners).

[Low-level Kernel](/core/kernel) is only needed for adapters, devtools, and custom primitives.
