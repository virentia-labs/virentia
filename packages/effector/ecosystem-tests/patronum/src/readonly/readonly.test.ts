/*
 * Copyright (c) 2020 Sergey Sova
 * Copyright (c) 2021 Effector core team
 * SPDX-License-Identifier: MIT
 * Source: https://github.com/effector/patronum
 */

import { createEvent, createStore, is } from "effector";
import { readonly } from "patronum/readonly";

it("should convert store to readonly store", () => {
  const $store = createStore({});
  const $result = readonly($store);

  expect(is.targetable($result)).toBe(false);
});

it("should convert event to readonly event", () => {
  const event = createEvent();
  const result = readonly(event);

  expect(is.targetable(result)).toBe(false);
});

it("should return store as-is if it is already derived", () => {
  const $store = createStore({});
  const $mapped = $store.map((state) => state);
  const $result = readonly($mapped);

  expect($result).toBe($mapped);
});

it("should return event as-is if it is already derived", () => {
  const event = createEvent();
  const mapped = event.map((value) => value);
  const result = readonly(mapped);

  expect(result).toBe(mapped);
});
