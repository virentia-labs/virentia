/*
 * Copyright (c) 2020 Sergey Sova
 * Copyright (c) 2021 Effector core team
 * SPDX-License-Identifier: MIT
 * Source: https://github.com/effector/patronum
 */

import { createEvent, createStore } from "effector";
import { empty } from "patronum/empty";

test("boolean", () => {
  const makeFalse = createEvent();
  const $a = createStore<boolean | null>(null).on(makeFalse, (_) => false);
  const $result = empty($a);

  expect($result.getState()).toBe(true);

  makeFalse();
  expect($result.getState()).toBe(false);
});

test("numbers", () => {
  const increment = createEvent();
  const $a = createStore<number | null>(null).on(increment, (a) => (a ?? -1) + 1);
  const $result = empty($a);

  expect($result.getState()).toBe(true);

  increment();
  expect($result.getState()).toBe(false);
});
