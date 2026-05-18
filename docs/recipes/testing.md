# Testing

Create a fresh scope for every test. Store values, effect handlers, and Effector associations should not leak between cases.

## Core

```ts
import { describe, expect, it } from "vitest";
import { allSettled, event, reaction, scope, scoped, store } from "@virentia/core";

describe("counter", () => {
  it("increments in an isolated scope", async () => {
    const testScope = scope();
    const incremented = event<number>();
    const count = store(0);

    reaction({
      on: incremented,
      run(amount) {
        count.value += amount;
      },
    });

    await allSettled(incremented, {
      scope: testScope,
      payload: 2,
    });

    scoped(testScope, () => {
      expect(count.value).toBe(2);
    });
  });
});
```

## Effector

Use real Effector and Virentia scopes. Create the association in test setup, then run code with the native tools of both libraries.

```ts
import { describe, expect, it } from "vitest";
import { event, reaction, scope as createVirentiaScope, scoped, store } from "@virentia/core";
import { createEffectorCompatibility } from "@virentia/effector";
import { allSettled, createEvent, fork, sample } from "effector";

describe("effector compatibility", () => {
  it("uses associated scopes", async () => {
    const effector = createEffectorCompatibility();
    const virentia = createVirentiaScope();
    const effectorScope = fork();
    const association = effector.associate({
      virentia,
      effector: effectorScope,
    });

    const submitted = createEvent<number>();
    const saved = event<number>();
    const total = store(0);

    reaction({ on: saved, run: (value) => (total.value += value) });
    sample({ clock: submitted, target: effector.asEffector(saved) });

    await scoped(virentia, () =>
      allSettled(submitted, {
        scope: effectorScope,
        params: 12,
      }),
    );

    expect(effector.ensureAssociation({ effector: effectorScope })).toBe(association);
    scoped(virentia, () => {
      expect(total.value).toBe(12);
    });
  });
});
```

If an association is missing, `@virentia/effector` throws. Create the association in setup code instead of relying on globals.
