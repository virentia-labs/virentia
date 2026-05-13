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

import { fork, serialize } from "@virentia/effector";
import { createField, createFieldset } from "./factory";

// Virentia upstream skip reason: Проверяет exact Effector factory SID hash generation; serialize/fork behavior покрывается SID-based tests без factory hash agreement.
test.skip("factory support", async () => {
  const username = createField("username", "guest");
  const age = createField("age", 0);
  const scope = fork({
    values: [
      [username.value, "alice"],
      [age.value, 21],
    ],
  });
  expect(serialize(scope)).toMatchInlineSnapshot(`
    Object {
      "-iajnln|-77rc2s": 21,
      "8iua16|-77rc2s": "alice",
    }
  `);
});

// Virentia upstream skip reason: Проверяет exact Effector nested factory SID hash generation; это Babel/factory internals, не runtime facade contract.
test.skip("nested factory support", async () => {
  const form = createFieldset(() => [createField("username", "guest"), createField("age", 0)]);
  const scope = fork({
    values: [
      [form.shape.username, "alice"],
      [form.shape.age, 21],
    ],
  });
  expect(serialize(scope)).toMatchInlineSnapshot(`
    Object {
      "-fjbluz|1104zu|-77rc2s": "alice",
      "-fjbluz|11jxl7|-77rc2s": 21,
    }
  `);
});
