/*
 * Copyright (c) 2020 Sergey Sova
 * Copyright (c) 2021 Effector core team
 * SPDX-License-Identifier: MIT
 * Source: https://github.com/effector/patronum
 */

import { allSettled, createEvent, createStore, fork } from "effector";
import { not } from "patronum/not";

it("correctly updates when value changes", async () => {
  const changeToFalse = createEvent();
  const $exists = createStore(true).on(changeToFalse, () => false);
  const $absent = not($exists);

  const scope = fork();
  expect(scope.getState($absent)).toBe(false);

  await allSettled(changeToFalse, { scope });
  expect(scope.getState($absent)).toBe(true);
});
