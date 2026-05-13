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

import { createStore, Store } from "@virentia/effector";

it("stack safe", () => {
  const DEPTH = 10000;
  const src: Store<number> = createStore(0);
  let current = src;
  for (let i = 0; i < DEPTH; i++) {
    current = current.map((n) => n + 1);
  }
  expect(current.getState()).toBe(DEPTH);
});
