# Effector operators

Use `effector.asEffector` when an Effector chain should call a Virentia unit.

```ts
sample({
  clock: effectorSubmitted,
  source: $session,
  fn: (session, id) => ({
    id,
    token: session.token,
  }),
  target: effector.asEffector(virentiaSubmitted),
});
```

The returned unit is created in Effector and can be passed to Effector APIs.

## Clock

The same wrapper can be used as a clock:

```ts
sample({
  clock: effector.asEffector(virentiaSubmitted),
  target: effectorSubmitted,
});
```

Virentia events are forwarded after the current transaction finishes.

## Association

Adapters need a pre-created association between a Virentia scope and an Effector scope:

```ts
const association = effector.associate({
  virentia: virentiaScope,
  effector: effectorScope,
});
```

The adapter reads the Effector scope from `stack.scope` while it runs and uses it to find the Virentia scope. If there is no pair, the adapter throws.
