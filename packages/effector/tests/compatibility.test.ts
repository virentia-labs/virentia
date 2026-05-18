import { describe, expect, it, vi } from "vitest";
import {
  allSettled as effectorAllSettled,
  createEvent,
  createStore,
  fork,
  sample,
} from "effector";
import { event, reaction, scope, scoped, store } from "@virentia/core";
import { createEffectorCompatibility } from "../lib";

describe("@virentia/effector", () => {
  it("uses explicitly associated scopes during regular scoped/allSettled execution", async () => {
    const effector = createEffectorCompatibility();
    const effectorSubmitted = createEvent<number>();
    const virentiaSubmitted = event<number>();
    const total = store(0);
    const virentiaScope = scope();
    const effectorScope = fork();
    const association = effector.associate({ virentia: virentiaScope, effector: effectorScope });

    reaction({
      on: virentiaSubmitted,
      run(value) {
        total.value += value;
      },
    });
    sample({
      clock: effectorSubmitted,
      target: effector.asEffector(virentiaSubmitted),
    });

    await scoped(virentiaScope, () =>
      effectorAllSettled(effectorSubmitted, {
        scope: effectorScope,
        params: 4,
      }),
    );

    expect(effector.ensureAssociation({ effector: effectorScope })).toBe(association);
    scoped(virentiaScope, () => {
      expect(total.value).toBe(4);
    });
  });

  it("keeps independent render associations isolated", async () => {
    const effector = createEffectorCompatibility();
    const effectorSubmitted = createEvent<number>();
    const virentiaSubmitted = event<number>();
    const total = store(0);
    const firstVirentiaScope = scope();
    const secondVirentiaScope = scope();
    const firstEffectorScope = fork();
    const secondEffectorScope = fork();
    const firstAssociation = effector.associate({
      virentia: firstVirentiaScope,
      effector: firstEffectorScope,
    });
    const secondAssociation = effector.associate({
      virentia: secondVirentiaScope,
      effector: secondEffectorScope,
    });

    reaction({
      on: virentiaSubmitted,
      run(value) {
        total.value += value;
      },
    });
    sample({
      clock: effectorSubmitted,
      target: effector.asEffector(virentiaSubmitted),
    });

    await scoped(firstVirentiaScope, () =>
      effectorAllSettled(effectorSubmitted, {
        scope: firstEffectorScope,
        params: 2,
      }),
    );
    await scoped(secondVirentiaScope, () =>
      effectorAllSettled(effectorSubmitted, {
        scope: secondEffectorScope,
        params: 5,
      }),
    );

    expect(effector.ensureAssociation({ effector: firstEffectorScope })).toBe(firstAssociation);
    expect(effector.ensureAssociation({ effector: secondEffectorScope })).toBe(secondAssociation);
    scoped(firstVirentiaScope, () => {
      expect(total.value).toBe(2);
    });
    scoped(secondVirentiaScope, () => {
      expect(total.value).toBe(5);
    });
  });

  it("uses the associated Effector scope for Virentia to Effector calls", async () => {
    const effector = createEffectorCompatibility();
    const virentiaSubmitted = event<number>();
    const effectorSubmitted = createEvent<number>();
    const $values = createStore<number[]>([]).on(effectorSubmitted, (values, value) => [
      ...values,
      value,
    ]);
    const virentiaScope = scope();
    const effectorScope = fork();
    const association = effector.associate({ virentia: virentiaScope, effector: effectorScope });

    effector.link(virentiaSubmitted, effectorSubmitted);

    scoped(virentiaScope, () => {
      virentiaSubmitted(7);
    });
    await effectorAllSettled(effectorScope);

    expect(effector.ensureAssociation({ effector: effectorScope })).toBe(association);
    expect(effectorScope.getState($values)).toEqual([7]);
  });

  it("does not create a hidden association for an unknown Effector scope", async () => {
    const effector = createEffectorCompatibility();
    const effectorSubmitted = createEvent<number>();
    const virentiaSubmitted = event<number>();
    const effectorScope = fork();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    sample({
      clock: effectorSubmitted,
      target: effector.asEffector(virentiaSubmitted),
    });

    try {
      await effectorAllSettled(effectorSubmitted, {
        scope: effectorScope,
        params: 1,
      });
    } finally {
      consoleError.mockRestore();
    }

    expect(() => effector.ensureAssociation({ effector: effectorScope })).toThrow(
      "Effector compatibility association is missing",
    );
  });

  it("removes disposed associations from lookups", async () => {
    const effector = createEffectorCompatibility();
    const effectorSubmitted = createEvent<number>();
    const virentiaSubmitted = event<number>();
    const virentiaScope = scope();
    const effectorScope = fork();
    const association = effector.associate({ virentia: virentiaScope, effector: effectorScope });

    sample({
      clock: effectorSubmitted,
      target: effector.asEffector(virentiaSubmitted),
    });
    await scoped(virentiaScope, () =>
      effectorAllSettled(effectorSubmitted, {
        scope: effectorScope,
        params: 1,
      }),
    );

    association.dispose();

    expect(() => effector.ensureAssociation({ effector: effectorScope })).toThrow(
      "Effector compatibility association is missing",
    );
    expect(() => effector.ensureAssociation({ virentia: virentiaScope })).toThrow(
      "Effector compatibility association is missing",
    );
  });

  it("does not allow one scope to be associated with two counterparts", () => {
    const effector = createEffectorCompatibility();
    const virentiaScope = scope();
    const firstEffectorScope = fork();
    const secondEffectorScope = fork();

    effector.associate({ virentia: virentiaScope, effector: firstEffectorScope });

    expect(() =>
      effector.associate({ virentia: virentiaScope, effector: secondEffectorScope }),
    ).toThrow("Virentia scope is already associated with another Effector scope");
  });
});
