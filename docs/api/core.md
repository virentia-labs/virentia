# @virentia/core API

Use `@virentia/core` to build state models.

## scope

Creates an isolated value container.

Use it when the same model must run without sharing state: one browser app, one request, one test, one mounted widget, or one cached screen.

```ts
import { scope } from "@virentia/core";

const appScope = scope();
```

Use one scope for an app instance, request, test, preview, or cached background model.

## scoped

Runs a function in a scope. If the function returns a promise, the same scope is kept for that promise chain until it settles.

```ts
import { store, scoped } from "@virentia/core";

const count = store(0);

scoped(appScope, () => {
  count.value = 1;
});
```

Use it to read and write stores directly.

```ts
await scoped(appScope, async () => {
  const response = await fetch("/api/count");
  count.value = (await response.json()).count;
});
```

`scoped` can also create a runner for repeated work and callbacks.

```ts
const inAppScope = scoped(appScope);

await inAppScope(() => loadFx());

const onMessage = inAppScope.wrap((message: string) => {
  messages.items = [...messages.items, message];
});
```

If the code already runs inside a scope, the scope argument can be omitted.

```ts
scoped(() => {
  count.value += 1;
});
```

## store

Creates a writable scoped store.

Use it for state the model owns. The same store definition can have different values in different scopes.

```ts
const count = store(0);
const profile = store({ name: "Ada", age: 36 });

scoped(appScope, () => {
  count.value += 1;
  profile.age = 37;
});
```

Derived stores:

```ts
const doubled = count.map((value) => value * 2);
const positive = count.filter((value) => value > 0);
const label = count.filterMap((value) => (value > 0 ? `#${value}` : "skip"), "skip");
```

`map`, `filter`, and `filterMap` create lazy read-only stores. Without subscriptions they recalculate only when read. If a reaction or UI observes them, they recalculate when dependencies change.

Subscribe to scoped updates:

```ts
const unsubscribe = count.subscribe((value, scope) => {
  console.log(value, scope);
});

unsubscribe();
```

## computed

Creates a read-only store with lazy evaluation.

```ts
const visibleUsers = computed(() => {
  const text = query.value.toLowerCase();

  return users.items.filter((user) => user.name.toLowerCase().includes(text));
});
```

`computed` caches its result separately in every scope. Dependencies are discovered automatically from stores read inside the function. Without active subscriptions it does not run after dependency changes until the value is read.

## lazyModel

Creates a lazy model facade.

Use it when a model is split into another module and should be imported only when one of its units is launched or called.

```ts
const chat = lazyModel(() =>
  import("./chat.model").then(({ createChatModel }) => createChatModel()),
);

await allSettled(chat.opened, {
  scope: appScope,
  payload: "chat:1",
});
```

Reactions can subscribe to lazy events and effect lifecycle units before the module is loaded. Store reads stay synchronous, so read lazy stores after the model has already been loaded.

## event

Creates a callable event.

Use it when the model needs to know that something happened. Events carry a payload and trigger connected reactions.

```ts
const submitted = event<{ text: string }>();
```

Use reactions to handle it:

```ts
reaction({
  on: submitted,
  run({ text }) {
    query.value = text;
  },
});
```

Derive events:

```ts
const textOnly = submitted.map(({ text }) => text);
const nonEmpty = textOnly.filter((text) => text.length > 0);
const normalized = nonEmpty.filterMap((text) => text.trim() || undefined);
```

## effect

Creates a callable side-effect unit.

Use it for async work. Effects expose lifecycle events and stores so the rest of the model can react to loading, success, failure, and aborts.

```ts
const loadUserFx = effect(async (id: string, { signal }) => {
  const response = await fetch(`/api/users/${id}`, { signal });
  return (await response.json()) as { id: string; name: string };
});
```

Effect units:

```ts
loadUserFx.started;
loadUserFx.done;
loadUserFx.failed;
loadUserFx.fail;
loadUserFx.doneData;
loadUserFx.failData;
loadUserFx.finally;
loadUserFx.settled;
loadUserFx.abort;
loadUserFx.aborted;
```

Effect stores:

```ts
loadUserFx.$pending;
loadUserFx.$inFlight;
```

Call inside a scope:

```ts
const user = await scoped(appScope, () => loadUserFx("user:1"));
```

Abort running calls:

```ts
await scoped(appScope, () => loadUserFx.abort(new Error("cancelled")));
```

Create an independent variant over the same handler:

```ts
const profileLoadUserFx = loadUserFx.variant("profileLoadUserFx");
const authorizedRequestFx = requestFx.variant("authorizedRequestFx", (id: number) => ({
  id,
  token: token.value,
}));
```

The variant has its own lifecycle units. It reuses the base effect handler and scoped handler overrides, but calling the variant does not emit the base effect lifecycle.

Use `EffectParams<typeof fx>`, `EffectDoneValue<typeof fx>`, and `EffectFailValue<typeof fx>` when a factory needs to reference an effect shape without importing a separately named params, result, or error type.

## attach

Creates a new effect that reads source stores and assembles params before running.

```ts
const authorizedFx = attach({
  source: token,
  effect: requestFx,
  mapParams: (id: number, token: string) => ({ id, token }),
});
```

`source` can be one store, an array of stores, or an object of stores. If `effect` is an existing effect, `attach` reuses its handler, while lifecycle belongs to the new effect.

## reaction

Creates a model rule.

Start with automatic dependency tracking by default: pass a function, read the stores it needs, and Virentia will discover which values the reaction depends on. The dependency list is refreshed every time the reaction runs.

Automatic reaction:

```ts
reaction(() => {
  fullName.value = `${firstName.value} ${lastName.value}`;
});
```

This is not the only mode. If the trigger itself matters — a specific event, effect, or lifecycle unit — use explicit `on`. In that form the payload stays visible, and the reaction runs only from the listed unit.

Explicit `on`:

```ts
reaction({
  on: submitted,
  run(payload) {
    console.log(payload);
  },
});
```

Multiple sources:

```ts
reaction({
  on: [firstChanged, secondChanged],
  run(payload) {
    console.log(payload);
  },
});
```

Stop a reaction:

```ts
const subscription = reaction({
  on: submitted,
  run() {},
});

subscription.stop();
```

## allSettled

Runs a unit or raw node and waits for async graph work.

Use it at explicit boundaries: tests, server loaders, commands, framework adapters, and places where passing `scope` is clearer than opening a scope frame.

```ts
await allSettled(submitted, {
  scope: appScope,
  payload: { text: "hello" },
});
```

Useful in tests, SSR, and library helpers.

## owner

Creates a lifecycle boundary.

Use it for models created at runtime. Everything registered inside can be disposed together.

```ts
const model = owner(() => {
  const incremented = event<void>();
  const count = store(0);

  reaction({
    on: incremented,
    run() {
      count.value += 1;
    },
  });

  return { count, incremented };
});

model.dispose();
```

The model root also receives `[Symbol.dispose]`, so runtimes with Explicit Resource Management support can use `using`.

```ts
{
  using model = owner(() => {
    return { count: store(0) };
  });
}
```

## onCleanup, getOwner, withOwner

Register cleanup on the owner from the current execution context:

Use cleanup utilities when a helper creates timers, subscriptions, browser listeners, or any resource that must be detached with the model.

```ts
owner((dispose) => {
  const timer = setInterval(() => {}, 1000);

  onCleanup(() => {
    clearInterval(timer);
  });

  return { dispose };
});
```

Attach cleanup to an existing owner:

```ts
const model = owner((dispose, currentOwner) => {
  return { dispose, owner: currentOwner };
});

withOwner(model.owner, () => {
  onCleanup(() => {
    console.log("cleanup");
  });
});
```

Read the current owner when writing helpers:

```ts
const current = getOwner();
```

## createNode and run

Low-level graph API for integrations.

Use this only when building new primitives or adapters. Application models should use stores, events, effects, and reactions.

```ts
const node = createNode((ctx) => {
  console.log(ctx.value);
});

await run({
  unit: node,
  payload: "hello",
  scope: appScope,
});
```

Inside a node, `ctx.stop()` stops the current branch, `ctx.fail(error)` stops it as a failed branch, and `ctx.launch(unit, value)` enqueues another node or unit in the same scope and execution context.

## createContext and withContexts

Pass execution metadata through kernel work.

Use contexts for metadata that belongs to one execution chain, such as request IDs, tracing data, or integration-specific flags. Use stores for application state.

```ts
const requestId = createContext<string>();

withContexts([requestId.setup("request-1")], () => {
  console.log(requestId.get());
});
```

Inside a node:

```ts
const node = createNode((ctx) => {
  console.log(ctx.getContext(requestId));
});
```
