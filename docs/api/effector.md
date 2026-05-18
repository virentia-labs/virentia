# @virentia/effector API

`@virentia/effector` connects Virentia units with units from the real `effector` package.

## createEffectorCompatibility

```ts
const effector = createEffectorCompatibility();
```

Creates a compatibility object. It stores links and adapters that will be applied to each association. Create it once for the application.

## effector.associate

```ts
const association = effector.associate({
  virentia: virentiaScope,
  effector: effectorScope,
});
```

Creates an association for a scope pair. When an adapter unit runs inside the Effector graph, it reads `stack.scope` and looks up the existing association. Call `association.dispose()` when it is no longer needed.

## effector.ensureAssociation

```ts
const association = effector.ensureAssociation({ effector: effectorScope });
```

Finds an existing association. Throws if it does not exist.

The association does not call units and does not participate in application execution. Start Effector through `allSettled`, `scopeBind`, `launch`, or the UI Provider, and start Virentia through `scoped` and `allSettled` from `@virentia/core`.

## effector.link

```ts
const unlink = effector.link(virentiaEvent, effectorEvent, ({ id }) => id);
```

Installs a link for every association created by this compatibility object.

## effector.asEffector

```ts
sample({
  clock: effectorEvent,
  target: effector.asEffector(virentiaEvent),
});
```

Returns an Effector wrapper for a Virentia unit. The wrapper reads the Effector scope from `stack.scope` and uses it to find the Virentia scope.

## effector.asVirentia

```ts
reaction({
  on: effector.asVirentia(effectorEvent),
  run(payload) {},
});
```

Returns a Virentia wrapper for an Effector unit.

If an adapter cannot find an association from the current Virentia scope or the Effector scope from `stack.scope`, the package throws.
