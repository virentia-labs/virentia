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

import { createEvent } from "@virentia/effector";

it("can use deep stack calls", () => {
  const fn = vi.fn();
  const a = createEvent<string>();
  const b = createEvent<string>();
  const c = createEvent<string>();
  const d = c.map((_) => _);
  const e = d.map((_) => _);
  const f = createEvent<string>();

  a.watch((data) => {
    b(data);
  });
  b.watch((data) => {
    c(data);
  });
  e.watch((data) => {
    f(data);
  });
  f.watch((data) => {
    fn(data);
  });

  a("payload");
  expect(fn).toHaveBeenCalledTimes(1);
  expect(fn).toHaveBeenCalledWith("payload");
});
