# Deep Knowledge

This page explains how Virentia works under the public API. You do not need it for ordinary application code. It is useful when you are writing adapters, debugging execution order, or deciding where a new primitive belongs.

## Units Are Graph Nodes

The public API talks about stores, events, effects, and reactions. Internally, each of them owns or creates graph nodes. A node is a small piece of executable graph work. Nodes are linked through `next`, so one unit can trigger another unit without knowing what it is connected to.

<NodeFlow kind="unit" />

When a boundary runs an event, Virentia does not immediately walk the whole graph by recursion. It creates work for the kernel queue. That work item contains the node, the payload, the scope, and execution contexts. The queue then flushes nodes in order.

This is why payload and scope travel together. The payload tells the next node what happened. The scope tells stores where values should be read or written.

## Stores Are Definitions, Scopes Hold Values

A store is not the value itself. The store owns a stable identity and knows how to read and write through that identity. The scope owns the actual values map.

<NodeFlow kind="scope" />

When code reads `query.value`, the store takes the scope from the current execution context, then looks up its own store id in that scope. If the value is missing, the store returns its initial value.

When code writes `query.value = "docs"`, the store runs its node in the current scope. The node commits the new value into `scope.values` and notifies subscribers that are watching that same scope.

This split is the reason model code is reusable. The model can be imported once, while each app instance, request, test, or cached screen gets its own value map.

## Reactions Are Edges With Behavior

An explicit reaction attaches a reaction node to the source unit.

For example, when a reaction listens to `queryChanged`, Virentia adds the reaction node to `queryChanged.node.next`. When the event runs, the kernel eventually reaches that reaction node with the same payload and scope. The reaction body can then write stores, call effects, or run other model logic.

Automatic reactions are the default mode for most model rules. At creation time, they run once and collect stores read during that run. Those store nodes become dependencies. When one dependency changes later, the reaction runs again and refreshes the dependency list.

Explicit reactions remain the alternative for places where the trigger itself matters: an event, effect, or lifecycle unit. In that form `on` makes the source and payload part of the rule.

## Effects Are Node Chains

An effect is not just an async function. It is a small graph around an async function.

<NodeFlow kind="effect" />

The start node increments `$inFlight`, updates `$pending`, and emits `started`. The execute node awaits the handler. The settle node decrements `$inFlight`, updates `$pending`, and emits success or failure units.

That lifecycle is available as normal units: `done`, `doneData`, `fail`, `failData`, `settled`, `$pending`, and `$inFlight`. Model code can react to those units exactly like it reacts to events.

Abort support is tied to each running call. The handler receives an `AbortSignal`, and disposing an owner can abort effect calls created inside that owner.

## The Kernel Queue

The kernel queue gives graph execution a controlled order. A node can return a value, stop the current branch, fail the current branch, or enqueue downstream nodes.

Each queued item carries:

- the node to run;
- the payload that entered this branch;
- the current value produced by the previous node;
- the scope;
- execution contexts;
- metadata used by integrations.

The scope is always part of the queued work. That is the important bit: once a unit starts in a scope, downstream nodes receive that same scope unless a lower-level integration intentionally changes it.

## Transactions And Drain Context

Every `run` call puts work into a drain context. A drain owns the queue, batched work items, waiters for callers that are waiting for the drain to finish, and pending child promises created by nested async work.

When there is no active drain, `run` creates one and drains it. When `run` is called while commit notifications are already draining, the work is appended to the active drain and the caller waits for that drain.

The important case is a direct unit call inside a running node:

```ts
reaction({
  on: opened,
  run() {
    first();
    second();
  },
});
```

While `first()` is called, the kernel is already inside a node. Virentia creates a child drain and executes it immediately. Then control returns to user code and `second()` runs. This is why explicit nested calls behave like normal JavaScript calls rather than being moved into a later priority wave.

Graph edges still use the current drain queue. A node can enqueue downstream work through `node.next` or `ctx.launch`.

```ts
const gate = createNode((ctx) => {
  ctx.stop();
  ctx.launch(nextNode, "value");
});
```

`ctx.launch` forwards the current scope, page context, metadata, value, and batch key into the same drain. It is useful for low-level adapters that need to route execution without pretending to be user-written synchronous calls.

## Transaction State And Commit

The active transaction stores pending writes by scope and store id:

```ts
type Transaction = {
  depth: number;
  writes: WeakMap<Scope, Map<StoreId, PendingWrite>>;
  scopes: Scope[];
};
```

The `WeakMap` isolates writes per scope. The inner `Map` means each store has one pending write per transaction. If a store is written several times, only the latest pending value is committed.

Store reads first check the transaction:

```txt
read store
  pending value exists in current transaction -> return pending value
  otherwise -> return committed scope value
```

Committing is split into two phases:

```txt
phase 1:
  apply all changed store values
  collect notify callbacks

phase 2:
  run notify callbacks
```

Subscribers should observe a committed graph, not a half-applied set of store writes. If two stores were changed in the same transaction, both committed values are installed before notifications start.

Notification callbacks can enqueue more work. That work goes through the active drain and, if it writes stores, through a new transaction. This keeps state writes and observer reactions separated without requiring a public batching API.

## Async Boundaries

If a node returns a promise, the kernel commits the active transaction before awaiting it. The continuation resumes later in the same scope and page context, but with a fresh transaction.

```txt
node starts
  write draft
  return promise
commit current transaction
await promise
resume node
enqueue downstream work
```

The runtime deliberately does not keep drafts alive across `await`. A long-lived draft would make stale writes, conflict resolution, and memory lifetime much harder to explain and debug. `scoped` preserves scope and causal context through async work; it does not preserve the transaction draft.

Effect lifecycle stores are an exception to domain-state batching. `$pending` and `$inFlight` are runtime execution signals, so they update immediately when async work starts or settles. Lifecycle events such as `started`, `doneData`, `failData`, and `settled` remain normal units; reactions to those events write business stores through the normal transactional path.

## Why Not Priority Layers

Virentia avoids a priority scheduler where store updates, derived invalidation, lifecycle units, and user reactions compete in hidden layers. That style can be powerful, but it also makes small changes in graph shape affect ordering in surprising ways.

The kernel instead follows two rules:

- explicit synchronous calls run now, in JavaScript order;
- graph edges are queued in the current drain and observe committed state after store commits.

Sibling reactions attached to the same source still have deterministic runtime order, but that order is not meant to define business decisions. If order matters, model it with explicit calls or react to committed state.

Warnings about read-after-write between sibling reactions and several sibling writes to the same store should be diagnostics, not a separate execution semantic. The runtime should not reorder work to "fix" such a model; devtools or runtime diagnostics should show the causality chain, source unit, scope, which reactions read or wrote the store, and why the result depends on registration order.

## Boundaries And Scope Context

`allSettled(unit, { scope })` is the cleanest boundary because scope is explicit. It creates graph work with the given scope and waits until async graph work settles.

`scoped(scope, fn)` is a short execution frame. It puts the scope into the current execution context so store reads and writes can happen in plain code. When the callback returns, the previous scope context is restored.

If the callback returns a promise, `scoped(scope, fn)` keeps that scope for the promise chain until it settles. It is useful for application-owned async work, but it should not be treated as a universal async context system for every parallel flow.

`scoped(scope).wrap(fn)` is the integration tool. It captures a scope once and reopens it when another library calls your callback later.

## Owners And Cleanup

Owners exist because runtime-created models need a way to detach work. Reactions, subscriptions, and cleanup callbacks registered inside an owner are tied to that owner.

When the owner is disposed, Virentia runs cleanup callbacks and detaches graph edges created inside it. This keeps dynamic models from leaving reactions behind after a modal, tab, or cached screen is removed.

## Practical Value

Most application code should not think about nodes. It should talk in stores, events, effects, reactions, scopes, and owners.

The node model matters when you build framework bindings, compatibility layers, persistence helpers, test helpers, devtools, or a new primitive. At that level, the key questions are always the same: what node runs, what payload travels, which scope owns the values, and who cleans up the edges later?
