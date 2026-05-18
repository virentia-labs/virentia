# Migration notes

Do not replace `effector` imports globally.

Keep existing Effector code on the real package:

```ts
import { createEvent, createStore } from "effector";

export const effectorSubmitted = createEvent<string>();
export const $userId = createStore("").on(effectorSubmitted, (_, id) => id);
```

Write new Virentia code separately:

```ts
import { event, store } from "@virentia/core";

export const virentiaSubmitted = event<{ id: string }>();
export const userId = store("");
```

Then connect the parts explicitly:

```ts
import { createEffectorCompatibility } from "@virentia/effector";

export const effector = createEffectorCompatibility();

effector.link(virentiaSubmitted, effectorSubmitted, ({ id }) => id);
```

Create an association where the Virentia scope is known:

```ts
const association = effector.associate({
  virentia: virentiaScope,
  effector: effectorScope,
});
```

The adapter reads the Effector scope from `stack.scope` when it runs inside the Effector graph and uses it to find the Virentia scope. This lets you move models gradually. Effector libraries keep using real Effector, while Virentia models stay in their own scope.

## Effector operators

Use `effector.asEffector` when existing Effector code needs to call a Virentia unit:

```ts
sample({
  clock: effectorSubmitted,
  target: effector.asEffector(virentiaSubmitted),
});
```
