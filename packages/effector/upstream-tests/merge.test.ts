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

import { merge, createEvent } from "@virentia/effector";
import { argumentHistory } from "effector/fixtures";

test("merge", () => {
  const fn = vi.fn();
  const foo = createEvent<number>();
  const bar = createEvent<number>();

  const baz = merge([foo, bar]);

  baz.watch((v) => fn(v));

  foo(1);
  bar(2);

  expect(argumentHistory(fn)).toMatchInlineSnapshot(`
    Array [
      1,
      2,
    ]
  `);
});
