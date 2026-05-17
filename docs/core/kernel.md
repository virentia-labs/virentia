# Low-level Kernel

Most application code should use stores, events, effects, reactions, and owners.

The low-level kernel exists for integrations that need direct graph nodes or custom execution context.

## createNode and run

```ts
import { createNode, run, scope } from "@virentia/core";

const appScope = scope();

const logNode = createNode((ctx) => {
  console.log(ctx.value);
});

await run({
  unit: logNode,
  payload: "hello",
  scope: appScope,
});
```

Nodes can pass values to downstream nodes.

```ts
const second = createNode((ctx) => {
  console.log(ctx.value); // "next"
});

const first = createNode({
  run: () => "next",
  next: [second],
});

await run({ unit: first, scope: appScope });
```

A node can also enqueue another branch explicitly. `ctx.launch` keeps the current scope, contexts, metadata, and batch key, but lets the node choose which unit receives the next value.

```ts
const gate = createNode((ctx) => {
  ctx.stop();
  ctx.launch(second, "next");
});
```

## Transactions

The user-facing model is described in [Transactions](/core/transactions). Runtime mechanics and design rationale live in [Deep Knowledge](/guide/deep-knowledge).

## Kernel Contexts

Kernel contexts pass execution metadata through a run chain.

```ts
const requestId = createContext<string>();

const node = createNode((ctx) => {
  console.log(ctx.getContext(requestId));
});

await run({
  unit: node,
  scope: appScope,
  contexts: [requestId.setup("request-42")],
});
```

Use stores for application state. Use kernel contexts for metadata that belongs to one execution.
