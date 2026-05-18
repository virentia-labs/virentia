# Scopes and serialization

Effector and Virentia keep state in different scopes. `@virentia/effector` stores an explicit scope pair:

```ts
const association = effector.associate({
  virentia: virentiaScope,
  effector: effectorScope,
});
```

The object returned by `createEffectorCompatibility` stays stable. The association is the disposable part: create it at a lifecycle boundary and release it with `dispose()`. After `dispose()`, the association is removed from the registry and can no longer be found through `ensureAssociation`.

## No implicit scopes

The package never creates a missing scope.

```ts
effector.ensureAssociation({ effector: effectorScope });
```

This works only if the Effector scope is already present in an association. Otherwise it throws.

## SSR

Create an association per request inside the render function:

```ts
export async function render(request: Request) {
  const virentiaScope = createVirentiaScope(request);
  const effectorScope = fork();

  const association = effector.associate({
    virentia: virentiaScope,
    effector: effectorScope,
  });

  try {
    await scoped(virentiaScope, () =>
      allSettled(appStarted, {
        scope: effectorScope,
        params: request,
      }),
    );
    return renderApp(association);
  } finally {
    association.dispose();
  }
}
```

Set the Virentia scope with `scoped`, and the Effector scope with `allSettled`, `scopeBind`, or the UI Provider. The association links these two scopes ahead of time and is released with `dispose()`.

Serialize the Virentia scope with Virentia snapshot tools and the Effector scope with `serialize` from Effector. The compatibility layer stores only the association between them.

## Late association

If bootstrap order makes early creation awkward, associate scopes later:

```ts
effector.associate({
  virentia: virentiaScope,
  effector: effectorScope,
});
```

The Effector scope is not created automatically and is not captured later. Pass it when creating the association.

## Effector scope

The compatibility layer does not guess the Effector scope from global state. The adapter unit reads `stack.scope` in `step.run`. For SSR and tests this is the scope from `fork()`. In React, it is the same scope that you pass to Effector Provider.
