# Transactions

Transactions are Virentia's execution boundary for synchronous model work. They let model code stay imperative while keeping observers away from half-written state.

This page explains the user-facing behavior. For runtime internals and design rationale, read [Deep Knowledge](/guide/deep-knowledge).

In short:

- synchronous unit calls share one transaction;
- store writes go into a transaction draft;
- store reads inside the transaction see the draft;
- stores commit once after the outer synchronous call finishes;
- reactions to committed store changes run after the commit;
- `await` ends the current transaction;
- effect lifecycle stores publish immediately.

## Why Transactions Exist

Without transactions, every store write would notify observers immediately. That is easy to implement, but awkward for real model code:

```ts
reaction({
  on: incremented,
  run() {
    count.value++;
    count.value++;
  },
});
```

The useful result is `count + 2`, not two separate UI renders and two separate computed invalidations. In Virentia the two writes update the transaction draft, and `count` commits once with the final value.

## What Starts A Transaction

A transaction starts when a unit is launched:

```ts
await allSettled(submitted, { scope: appScope });
```

The same rule applies to direct unit calls inside an active scope:

```ts
scoped(appScope, () => {
  submitted();
});
```

A direct store write outside an existing transaction creates a small implicit transaction:

```ts
scoped(appScope, () => {
  count.value = 1;
});
```

Most users do not need to open or close transactions manually. They are a runtime rule, not a separate public primitive.

## Draft Reads

Inside a transaction, later code reads the current draft value.

```ts
reaction({
  on: incremented,
  run() {
    count.value++;
    console.log(count.value); // already includes the increment

    count.value++;
    console.log(count.value); // includes both increments
  },
});
```

Outside the transaction, observers see only committed values. Subscribers, derived stores, reactions, and UI bindings do not see the intermediate value after the first write.

## Commit And Notifications

At the end of the outer synchronous transaction, Virentia commits changed stores. Each changed store applies its final value and then notifies subscribers.

```txt
unit starts
  read stores
  write drafts
  call nested units
commit changed stores
notify subscribers and derived graph
run reactions caused by committed stores
```

If a store receives the same value according to `Object.is`, it is skipped.

Follow-up reactions caused by committed stores run after the commit. If those reactions write more stores, those writes are batched in their own follow-up transaction. This keeps writes and notifications separated: model code can write freely, and observers react to committed state.

## Explicit Nested Calls

Explicit synchronous calls keep normal JavaScript order.

```ts
reaction({
  on: featureTogglePressed,
  run() {
    featureEnabled();
    legacyModeDisabled();
  },
});
```

`featureEnabled` runs before `legacyModeDisabled`. If both branches read and write the same store, the second branch sees draft changes made by the first branch.

This is intentional. When the user writes calls in a specific order, Virentia respects that order instead of reshuffling the work into priority layers.

## Sibling Reactions

Independent reactions attached to the same unit are different from explicit nested calls.

```ts
reaction({
  on: submitted,
  run() {
    count.value = 1;
  },
});

reaction({
  on: submitted,
  run() {
    console.log(count.value);
  },
});
```

The runtime order is deterministic, but business logic should not depend on sibling reaction order. If one sibling writes a store and another sibling reads the same store in the same transaction, the result depends on subscription order.

::: warning

Treat this code as order-dependent. Virentia does not forbid it, because it can be useful in low-level scenarios, but business rules should not be based on sibling reaction registration order.

:::

Prefer one of these shapes:

```ts
reaction({
  on: submitted,
  run() {
    count.value = 1;
    nextStep();
  },
});
```

Or react to the committed store value:

```ts
reaction({
  on: count,
  run(value) {
    console.log(value);
  },
});
```

## Multiple Writes And Conflicts

Multiple writes in explicit code are valid. The last explicit write wins.

```ts
reaction({
  on: changed,
  run() {
    count.value = 1;
    count.value = 2;
  },
});
```

That commits `2`.

Multiple independent sibling reactions writing the same store are allowed by the runtime, but they are usually a modeling smell:

```ts
reaction({ on: changed, run: () => { count.value = 1; } });
reaction({ on: changed, run: () => { count.value = 2; } });
```

This also has a deterministic result, but the important rule is: do not encode business decisions in sibling order. Put the decision in one reaction, call units explicitly, or move append/merge-heavy data into a dedicated primitive when one exists.

::: warning

If devtools or runtime diagnostics highlight several sibling writes to the same store, treat it as a modeling smell. It is not necessarily an execution error, but it is usually a weak point in causality.

:::

## Effects And Lifecycle Stores

Effects have lifecycle stores:

```ts
searchFx.$pending;
searchFx.$inFlight;
```

These stores are runtime execution state. They publish immediately when async work starts or settles, even if the effect was launched inside a transaction.

```ts
reaction({
  on: submitted,
  run() {
    formTouched.value = true;
    searchFx(query.value);
  },
});
```

`searchFx.$pending` becomes `true` immediately. UI can show loading state without waiting for unrelated business-state commits.

Lifecycle events such as `started`, `doneData`, `failData`, and `settled` still behave like normal units. If reactions to those events write business stores, those writes are transactional.

## Async Boundaries

`await` ends the current transaction. Pending store writes commit before the async continuation resumes.

```ts
scoped(appScope, async () => {
  saving.value = true;

  const user = await saveUserFx(form.value);

  profile.value = user;
  saving.value = false;
});
```

This behaves as two transactions:

```txt
transaction 1:
  saving = true
commit

await saveUserFx

transaction 2:
  profile = user
  saving = false
commit
```

The draft does not live across `await`. Keeping a mutable draft alive across async work would make lifetime and conflict rules hard to reason about.

```ts
const runInScope = scoped(appScope);

button.addEventListener("click", runInScope.wrap(async () => {
  saving.value = true;
  await saveFx();
  saving.value = false;
}));
```

In this shape, `scoped` is not extending the transaction. It only preserves the scope through an external callback or async continuation. Each synchronous segment still gets its own transaction.

## Practical Rules

- Write direct imperative model code when the order is explicit.
- Let stores commit once instead of forcing manual batching.
- React to committed store values when logic depends on the result of a write.
- Do not rely on sibling reaction order for business decisions.
- Use effect lifecycle stores for UI execution state.
- Use `scoped` around async callbacks that need scope.
- Treat `await` as a transaction boundary.

The model is deliberately close to JavaScript: synchronous code runs in the order you wrote it, async work splits the execution, and observers see committed state instead of every intermediate write.
