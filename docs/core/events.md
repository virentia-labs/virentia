# Events

An event tells the model that something happened. It does not store state and does not decide what happens next. Its job is to carry a payload into the graph so reactions can respond.

```ts
const queryChanged = event<string>();
const submitted = event<void>();
```

A good event usually names either a fact or a domain intent. Facts sound like something that already happened: `queryChanged`, `submitted`, `messageReceived`, `routeOpened`. Intents are useful when the model exposes a small public command, for example `open`, `close`, or `submit` in a modal model. What is worth avoiding is a technical setter like `setQuery` or `updateState`: it ties the model to a mutation method instead of the meaning of the action.

## State Changes Live In Reactions

An event does not change state by itself. State changes in a reaction.

```ts
reaction({
  on: queryChanged,
  run(text) {
    query.value = text;
  },
});
```

Several rules can react to one event. `submitted` can start a search effect, clear an error, and record the last submit time. The event still stays small and readable.

## Payload

The payload is the event data. For `queryChanged`, it is the new text. For `messageReceived`, it is the message. For `submitted`, no payload may be needed, so use `event<void>()`.

Do not put more into the payload than a rule needs. If a reaction can read the current value from a store, it is often better to read it there than to carry extra data through the event.
