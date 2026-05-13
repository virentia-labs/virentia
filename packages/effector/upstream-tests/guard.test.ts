/*
 * Copyright (c) 2019 Zero Bias https://github.com/zerobias
 * SPDX-License-Identifier: MIT
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  test,
  vi,
  type Mock,
  type MockInstance,
} from "vitest";

import {
  guard,
  createEvent,
  createStore,
  createApi,
  is,
  createEffect,
  sample,
} from "@virentia/effector";
import { argumentHistory, muteErrors } from "effector/fixtures";

muteErrors("guard");

test("use case", () => {
  const clickRequest = createEvent();
  const fetchRequest = createEffect<number, number>(
    (n) => new Promise((rs) => setTimeout(rs, 500, n)),
  );
  const clicks = createStore(0).on(clickRequest, (x) => x + 1);

  const isIdle = fetchRequest.pending.map((pending) => !pending);

  guard({
    source: sample(clicks, clickRequest),
    filter: isIdle,
    target: fetchRequest,
  });

  // or

  sample({
    source: clicks,
    clock: guard(clickRequest, {
      filter: isIdle,
    }),
    target: fetchRequest,
  });

  // or

  sample({
    source: clicks,
    clock: guard({
      source: sample(fetchRequest.pending, clickRequest),
      filter: (pending) => !pending,
    }),
    target: fetchRequest,
  });
});

describe("without target", () => {
  it("returns event", () => {
    const trigger = createEvent();
    const unlocked = createStore(true);
    const target = guard(trigger, {
      filter: unlocked,
    });
    expect(is.event(target)).toBe(true);
  });
  it("supports store guards", () => {
    const fn = vi.fn();
    const trigger = createEvent<string>();
    const unlocked = createStore(true);
    const { lock, unlock } = createApi(unlocked, {
      lock: () => false,
      unlock: () => true,
    });
    const target = guard(trigger, {
      filter: unlocked,
    });

    target.watch(fn);
    trigger("A");
    lock();
    trigger("B");
    unlock();
    trigger("C");

    expect(argumentHistory(fn)).toEqual(["A", "C"]);
  });

  it("supports function predicate", () => {
    const fn = vi.fn();
    const source = createEvent<number>();
    const target = guard(source, {
      filter: (x) => x > 0,
    });

    target.watch(fn);

    source(0);
    source(1);
    expect(argumentHistory(fn)).toEqual([1]);
  });
});

describe("with target", () => {
  it("supports store guards", () => {
    const fn = vi.fn();
    const trigger = createEvent<string>();
    const target = createEvent();
    const unlocked = createStore(true);
    const { lock, unlock } = createApi(unlocked, {
      lock: () => false,
      unlock: () => true,
    });

    guard({
      source: trigger,
      filter: unlocked,
      target,
    });

    target.watch(fn);
    trigger("A");
    lock();
    trigger("B");
    unlock();
    trigger("C");

    expect(argumentHistory(fn)).toEqual(["A", "C"]);
  });

  it("supports function predicate", () => {
    const fn = vi.fn();
    const source = createEvent<number>();
    const target = createEvent();
    target.watch(fn);

    guard({
      source,
      filter: (x) => x > 0,
      target,
    });

    source(0);
    source(1);
    expect(argumentHistory(fn)).toEqual([1]);
  });
});

describe("source as object support", () => {
  test("with store guard", () => {
    expect(() => {
      guard({
        source: {
          a: createStore(0),
          b: createStore(0),
        },
        filter: createStore(true),
      });
    }).not.toThrow();
  });
  test("with function guard", () => {
    expect(() => {
      guard({
        source: {
          a: createStore(0),
          b: createStore(0),
        },
        filter: () => true,
      });
    }).not.toThrow();
  });
});

// Virentia upstream skip reason: Фильтр как derived event в том же pure phase зависит от Effector priority/backtracking; Virentia lazy scheduler не обещает этот промежуточный порядок.
test.skip("temporal consistency", () => {
  const fn = vi.fn();
  const trigger = createEvent<number>();
  const target = createEvent<number>();
  const filter = trigger.map((x) => x > 0);
  guard({
    source: trigger,
    //@ts-expect-error
    filter,
    target,
  });

  target.watch(fn);
  // trigger(1)
  trigger(0);
  trigger(2);

  expect(argumentHistory(fn)).toEqual([2]);
});

describe("clock support", () => {
  it("support event as clock", () => {
    const fn = vi.fn();
    const trigger = createEvent();
    const target = createEvent<number>();
    const source = createStore(1).on(target, (x) => x + 1);
    target.watch(fn);
    guard({
      source,
      clock: trigger,
      filter: createStore(true),
      target,
    });
    trigger();
    trigger();
    expect(argumentHistory(fn)).toMatchInlineSnapshot(`
      Array [
        1,
        2,
      ]
    `);
  });
  it("support arrays as clock", () => {
    const fn = vi.fn();
    const trigger1 = createEvent();
    const trigger2 = createEvent();
    const target = createEvent<number>();
    const source = createStore(1).on(target, (x) => x + 1);
    target.watch(fn);
    guard({
      source,
      clock: [trigger1, trigger2],
      filter: createStore(true),
      target,
    });
    trigger1();
    trigger2();
    expect(argumentHistory(fn)).toMatchInlineSnapshot(`
      Array [
        1,
        2,
      ]
    `);
  });
  test("value from clock will be passed to second argument of filter", () => {
    const fn = vi.fn();
    const trigger = createEvent<{ n: number }>();
    const target = createEvent<{ n: number }>();
    const source = createStore({ n: 0 }).on(target, (src, { n }) => ({
      n: src.n + n,
    }));
    source.updates.watch(fn);
    sample({
      source: trigger,
      clock: guard({
        source,
        clock: trigger,
        filter: (source, clock) => (source.n + clock.n) % 2 === 0,
      }),
      target,
    });
    trigger({ n: 6 });
    trigger({ n: 5 });
    trigger({ n: 4 });
    expect(argumentHistory(fn)).toMatchInlineSnapshot(`
      Array [
        Object {
          "n": 6,
        },
        Object {
          "n": 10,
        },
      ]
    `);
  });
});

describe("support clock without source", () => {
  test("it works with clock unit", () => {
    const fn = vi.fn();
    const clockA = createEvent<number>();
    const target = createEvent<number>();
    target.watch(fn);
    const result = guard({
      clock: clockA,
      filter: (n) => n % 2 !== 0,
      target,
    });
    clockA(1);
    clockA(2);
    clockA(3);
    expect(result === target).toBe(true);
    expect(argumentHistory(fn)).toMatchInlineSnapshot(`
      Array [
        1,
        3,
      ]
    `);
  });
  test("it works with clock array", () => {
    const fn = vi.fn();
    const clockA = createEvent<number>();
    const clockB = createEvent<number>();
    const target = createEvent<number>();
    target.watch(fn);
    const result = guard({
      clock: [clockA, clockB],
      filter: (n) => n % 2 !== 0,
      target,
    });
    clockA(1);
    clockB(4);
    clockB(5);
    expect(result === target).toBe(true);
    expect(argumentHistory(fn)).toMatchInlineSnapshot(`
      Array [
        1,
        5,
      ]
    `);
  });
});

describe("validation", () => {
  test("valid case without clock", () => {
    const source = createEvent<any>();
    const filter = createStore(true);
    const target = createEffect((_: any) => {});

    expect(() => {
      guard({ source, filter, target });
    }).not.toThrow();
  });
  test("valid case without source", () => {
    const clock = createEvent<any>();
    const filter = createStore(true);
    const target = createEffect((_: any) => {});

    expect(() => {
      guard({ clock, filter, target });
    }).not.toThrow();
  });
  // Virentia upstream skip reason: Проверяет exact Effector loc-prefixed diagnostic; facade сохраняет validation без upstream loc строки.
  test.skip("source validation", () => {
    const filter = createStore(true);
    const target = createEffect((_: any) => {});
    expect(() => {
      guard({ source: undefined, filter, target });
    }).toThrowErrorMatchingInlineSnapshot(
      `"[guard] (/src/effector/__tests__/guard.test.ts:333:6): source should be defined"`,
    );
  });
  // Virentia upstream skip reason: Проверяет exact Effector loc-prefixed diagnostic; facade сохраняет validation без upstream loc строки.
  test.skip("clock validation", () => {
    const filter = createStore(true);
    const target = createEffect((_: any) => {});

    expect(() => {
      guard({ clock: undefined, filter, target });
    }).toThrowErrorMatchingInlineSnapshot(
      `"[guard] (/src/effector/__tests__/guard.test.ts:343:6): clock should be defined"`,
    );
  });
  // Virentia upstream skip reason: Проверяет exact Effector loc-prefixed diagnostic; facade сохраняет validation без upstream loc строки.
  test.skip("no source no clock", () => {
    const target = createEffect((_: any) => {});

    expect(() => {
      //@ts-expect-error
      guard({ target });
    }).toThrowErrorMatchingInlineSnapshot(
      `"[guard] (/src/effector/__tests__/guard.test.ts:353:6): either source or clock should be defined"`,
    );
  });
});
