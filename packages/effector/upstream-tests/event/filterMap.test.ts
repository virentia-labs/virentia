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
import { argumentHistory } from "effector/fixtures";

describe("upstream event/filterMap.test.ts", () => {
  describe("event.filterMap", () => {
    test("event.filterMap should infer type", () => {
      const fn = vi.fn();
      const num = createEvent<number | "-1">();

      const evenNum = num.filterMap((n) => {
        if (n !== "-1") return n;
      });

      evenNum.watch((e) => fn(e));

      num(0);
      num("-1");
      num(2);
      num("-1");
      num(4);

      expect(argumentHistory(fn)).toMatchInlineSnapshot(`
    Array [
      0,
      2,
      4,
    ]
  `);
    });

    test("event.filterMap should drop undefined values", () => {
      const fn = vi.fn();
      const num = createEvent<number>();
      const evenNum = num.filterMap((n) => {
        if (n % 2 === 0) return n * 2;
      });

      evenNum.watch((e) => fn(e));

      num(0);
      num(1);
      num(2);
      num(3);
      num(4);

      expect(argumentHistory(fn)).toMatchInlineSnapshot(`
    Array [
      0,
      4,
      8,
    ]
  `);
    });
  });
});
