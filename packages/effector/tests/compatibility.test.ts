import { describe, expect, it, vi } from "vitest";
import { allSettled as effectorAllSettled, createEvent, createStore, fork, sample } from "effector";
import { event, reaction, scope, scoped, store } from "@virentia/core";
import { associate, effectorAssociations, ensureAssociation, fool } from "../lib";

describe("@virentia/effector", () => {
  it("uses the associated Virentia scope when an Effector unit runs in its scope", async () => {
    const effectorSubmitted = createEvent<number>();
    const virentiaSubmitted = fool(event<number>());
    const total = store(0);
    const virentiaScope = scope();
    const effectorScope = fork();
    const association = associate({ virentia: virentiaScope, effector: effectorScope });

    reaction({
      on: virentiaSubmitted,
      run(value) {
        total.value += value;
      },
    });
    sample({
      clock: effectorSubmitted,
      target: virentiaSubmitted,
    });

    await effectorAllSettled(effectorSubmitted, {
      scope: effectorScope,
      params: 4,
    });

    expect(ensureAssociation({ effector: effectorScope })).toBe(association);
    expect(effectorAssociations.byVirentia.get(virentiaScope)).toBe(association);
    expect(effectorAssociations.byEffector.get(effectorScope)).toBe(association);
    scoped(virentiaScope, () => {
      expect(total.value).toBe(4);
    });
  });

  it("keeps independent render associations isolated", async () => {
    const effectorSubmitted = createEvent<number>();
    const virentiaSubmitted = fool(event<number>());
    const total = store(0);
    const firstVirentiaScope = scope();
    const secondVirentiaScope = scope();
    const firstEffectorScope = fork();
    const secondEffectorScope = fork();
    const firstAssociation = associate({
      virentia: firstVirentiaScope,
      effector: firstEffectorScope,
    });
    const secondAssociation = associate({
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
      target: virentiaSubmitted,
    });

    await effectorAllSettled(effectorSubmitted, {
      scope: firstEffectorScope,
      params: 2,
    });
    await effectorAllSettled(effectorSubmitted, {
      scope: secondEffectorScope,
      params: 5,
    });

    expect(ensureAssociation({ effector: firstEffectorScope })).toBe(firstAssociation);
    expect(ensureAssociation({ effector: secondEffectorScope })).toBe(secondAssociation);
    scoped(firstVirentiaScope, () => {
      expect(total.value).toBe(2);
    });
    scoped(secondVirentiaScope, () => {
      expect(total.value).toBe(5);
    });
  });

  it("lets one fooled Effector unit work as an Effector and Virentia unit", async () => {
    const submitted = fool(createEvent<number>());
    const $values = createStore<number[]>([]).on(submitted, (values, value) => [...values, value]);
    const total = store(0);
    const virentiaScope = scope();
    const effectorScope = fork();

    associate({ virentia: virentiaScope, effector: effectorScope });
    reaction({
      on: submitted,
      run(value) {
        total.value += value;
      },
    });

    await effectorAllSettled(submitted, {
      scope: effectorScope,
      params: 3,
    });
    await scoped(virentiaScope, () => {
      return submitted(4);
    });

    expect(effectorScope.getState($values)).toEqual([3, 4]);
    scoped(virentiaScope, () => {
      expect(total.value).toBe(7);
    });
  });

  it("uses fooled Virentia units as Effector clock source and target", async () => {
    const sessionChanged = fool(event<{ token: string }>());
    const userSelected = fool(event<string>());
    const userOpened = fool(event<{ userId: string; token: string }>());
    const opened: Array<{ userId: string; token: string }> = [];
    const virentiaScope = scope();
    const effectorScope = fork();

    associate({ virentia: virentiaScope, effector: effectorScope });
    sample({
      clock: userSelected,
      source: sessionChanged,
      fn: (session, userId) => ({ userId, token: session.token }),
      target: userOpened,
    });
    reaction({
      on: userOpened,
      run(value) {
        opened.push(value);
      },
    });

    await scoped(virentiaScope, async () => {
      await sessionChanged({ token: "session-token" });
      await userSelected("user:1");
    });

    expect(opened).toEqual([{ userId: "user:1", token: "session-token" }]);
  });

  it("uses fooled Effector units as Effector clock source target and Virentia units", async () => {
    const $session = fool(createStore({ token: "session-token" }));
    const userSelected = fool(createEvent<string>());
    const userOpened = fool(createEvent<{ userId: string; token: string }>());
    const opened: Array<{ userId: string; token: string }> = [];
    const virentiaScope = scope();
    const effectorScope = fork();

    associate({ virentia: virentiaScope, effector: effectorScope });
    sample({
      clock: userSelected,
      source: $session,
      fn: (session, userId) => ({ userId, token: session.token }),
      target: userOpened,
    });
    reaction({
      on: userOpened,
      run(value) {
        opened.push(value);
      },
    });

    await scoped(virentiaScope, () => userSelected("user:1"));

    expect(opened).toEqual([{ userId: "user:1", token: "session-token" }]);
  });

  it("does not create a hidden association for an unknown Effector scope", async () => {
    const effectorSubmitted = createEvent<number>();
    const virentiaSubmitted = fool(event<number>());
    const effectorScope = fork();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    sample({
      clock: effectorSubmitted,
      target: virentiaSubmitted,
    });

    try {
      await effectorAllSettled(effectorSubmitted, {
        scope: effectorScope,
        params: 1,
      });
    } finally {
      consoleError.mockRestore();
    }

    expect(() => ensureAssociation({ effector: effectorScope })).toThrow(
      "Effector association is missing",
    );
  });

  it("does not allow one scope to be associated with two counterparts", () => {
    const virentiaScope = scope();
    const firstEffectorScope = fork();
    const secondEffectorScope = fork();

    associate({ virentia: virentiaScope, effector: firstEffectorScope });

    expect(() => associate({ virentia: virentiaScope, effector: secondEffectorScope })).toThrow(
      "Virentia scope is already associated with another Effector scope",
    );
  });
});
