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

// Virentia upstream skip reason: Патчит скрытый event.create hook Effector; это внутренний DI escape hatch, а не внешний API.
describe.skip("upstream event/di.test.ts", () => {
  test("event.create single argument", () => {
    const foo = createEvent<number>() as any;
    const oldCreate = foo.create;
    foo.create = vi.fn((payload, args) => oldCreate(payload, args));
    const baz = vi.fn();
    foo.watch(baz);
    foo(100);
    foo(200);
    foo(300);
    expect(argumentHistory(baz)).toMatchInlineSnapshot(`
    Array [
      100,
      200,
      300,
    ]
  `);
    expect(foo.create.mock.calls).toMatchInlineSnapshot(`
    Array [
      Array [
        100,
        Array [],
      ],
      Array [
        200,
        Array [],
      ],
      Array [
        300,
        Array [],
      ],
    ]
  `);
  });

  test("event.create multiple arguments", () => {
    const baz = vi.fn();
    const bar = createEvent() as any;
    const oldCreate = bar.create;
    bar.create = vi.fn((payload, args) => oldCreate([payload, ...args], []));
    bar.watch(baz);
    bar(-2, "foo");
    bar(-3, "bar");
    bar(-2, "baz");
    expect(argumentHistory(baz)).toMatchInlineSnapshot(`
    Array [
      Array [
        -2,
        "foo",
      ],
      Array [
        -3,
        "bar",
      ],
      Array [
        -2,
        "baz",
      ],
    ]
  `);
    expect(bar.create.mock.calls).toMatchInlineSnapshot(`
    Array [
      Array [
        -2,
        Array [
          "foo",
        ],
      ],
      Array [
        -3,
        Array [
          "bar",
        ],
      ],
      Array [
        -2,
        Array [
          "baz",
        ],
      ],
    ]
  `);
  });
});
