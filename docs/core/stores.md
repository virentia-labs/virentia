# Stores

A store holds a model value. If the application needs to remember something between events, it is usually a store: field text, a selected id, a message list, form status, cached data.

```ts
const query = store("");
const profile = store({ name: "Ada", age: 36 });
```

A store is not a global variable. It describes a value that exists in the model, while the concrete value lives in a scope. The same store can therefore have different values in different scopes.

```ts
const first = scope();
const second = scope();

scoped(first, () => {
  query.value = "docs";
});

scoped(second, () => {
  query.value = "api";
});
```

In the first scope `query` is `"docs"`. In the second scope it is `"api"`. The model code is the same.

## Reading And Writing

Primitive stores use `.value`.

```ts
count.value += 1;
```

Object stores expose fields directly.

```ts
profile.age += 1;
```

Direct reads and writes need a scope in the current execution context. If you are not inside a reaction, effect handler, or another model run, open the scope with `scoped(scope, fn)`.

Store writes are transactional. Several writes made during one synchronous unit tree are batched into one commit, and reactions observe the committed final value.

```ts
reaction({
  on: incremented,
  run() {
    count.value++;
    count.value++;
  },
});
```

Inside the transaction, later code reads the current draft value. Outside the transaction, subscribers and derived stores are notified after commit.

The full execution model is described in [Transactions](/core/transactions).

## Derived Stores

Use a derived store when a value fully follows another value. For example, a search label can be derived from the query instead of being updated by hand in every reaction.

```ts
const queryLabel = query.map((text) => (text ? `Searching: ${text}` : "Search"));
```

Derived stores are lazy. If no reaction or UI is subscribed to a derived store, a source store change only marks its cache dirty. The value is recalculated later, when it is explicitly read. If a derived store is active, for example observed by a reaction, dependency changes recalculate it immediately and notify subscribers only when the result actually changed.

If the value depends on an event in time, it is not derived state. Use a normal store and update it through a reaction.

## Lazy Computations

Use `computed` for values that are derived from state but should not be recalculated until they are read. It fits heavier filtering, sorting, view-model assembly, or rules where dependencies are best discovered from actual reads.

```ts
const query = store("");
const users = store({ items: [] as User[] });

const visibleUsers = computed(() => {
  const text = query.value.toLowerCase();

  return users.items.filter((user) => user.name.toLowerCase().includes(text));
});
```

`visibleUsers` behaves like a read-only store. The first read in a scope runs the function and caches the result. Later reads reuse the cache. When `query` or `users` changes in the same scope, the cache becomes dirty, but the value is not recomputed until it is read again or observed by a reaction, subscription, or UI.

A regular `store()` is always active: writes must preserve the new value. Derived stores become active only when observed. Use `map` for a small derived store from one source. Use `computed` when the calculation is expensive, depends on several stores, or depends on branches inside the function.
