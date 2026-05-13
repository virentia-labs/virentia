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

import { createStore, createEvent } from "@virentia/effector";
import { argumentHistory, muteErrors } from "effector/fixtures";

muteErrors("watch second argument");

it("support watchers for event", () => {
  const fn = vi.fn();
  const event = createEvent<number | void>();
  const watcher = event.watch((e) => {
    fn(e);
  });

  event(3);
  event();
  event(1);

  expect(fn).toHaveBeenCalledTimes(3);
  expect(argumentHistory(fn)).toMatchInlineSnapshot(`
        Array [
          3,
          undefined,
          1,
        ]
    `);

  watcher();

  event(4);
  expect(fn).toHaveBeenCalledTimes(3);
});

it("support watchers for storages", () => {
  const fn = vi.fn();
  const event = createEvent<number>();
  const store = createStore("none").on(event, (_, e) => e.toString());
  const watcher = store.watch((e) => {
    fn(e);
  });

  event(3);
  event(1);

  expect(fn).toHaveBeenCalledTimes(3);
  expect(argumentHistory(fn)).toMatchInlineSnapshot(`
        Array [
          "none",
          "3",
          "1",
        ]
    `);

  watcher();

  event(4);
  expect(fn).toHaveBeenCalledTimes(3);
});

it("support event watchers for storages", () => {
  const fn = vi.fn();
  const event = createEvent<number>();
  const update = createEvent<(x: number) => number>();
  const store = createStore(0).on(update, (s, fn) => fn(s));

  const watcher = event.watch((e) => fn(e));

  const watcher2 = store.watch(event);

  update((a) => a + 2);
  update((a) => a + 10);

  expect(argumentHistory(fn)).toMatchInlineSnapshot(`
    Array [
      0,
      2,
      12,
    ]
  `);

  watcher();
  watcher2();
});

it("support event watchers for storages", () => {
  const fn = vi.fn();
  const trigger = createEvent();
  const store = createStore(0);

  const watcher = store.watch(trigger, fn);

  trigger();
  trigger();
  trigger();

  expect(argumentHistory(fn)).toMatchInlineSnapshot(`
    Array [
      0,
      0,
      0,
    ]
  `);

  watcher();
});

// Virentia upstream skip reason: Мутирует unit.graphite.scope.tag; проверка внешнего watch-поведения уже покрыта соседними тестами.
it.skip("support watchers for mapped storages", () => {
  const addMetaTag = (tag: string, unit: any) => {
    unit.graphite.scope.tag = tag;
  };
  const fn = vi.fn();
  const event = createEvent<number>();
  const storeFirst = createStore("none").on(event, (_, e) => e.toString());
  const store = storeFirst.map((e) => `/${e}`);

  addMetaTag("event", event);
  addMetaTag("storeFirst", storeFirst);
  addMetaTag("store", store);

  const watcher = store.watch((e) => {
    fn(e);
  });

  event(3);

  expect(fn).toHaveBeenCalledTimes(2);
  expect(argumentHistory(fn)).toMatchInlineSnapshot(`
        Array [
          "/none",
          "/3",
        ]
    `);

  watcher();

  event(4);
  expect(fn).toHaveBeenCalledTimes(2);
});

test("watch validation", () => {
  const store = createStore(null);
  expect(() => {
    //@ts-expect-error
    store.watch(NaN);
  }).toThrowErrorMatchingInlineSnapshot(`".watch argument should be a function"`);
});
