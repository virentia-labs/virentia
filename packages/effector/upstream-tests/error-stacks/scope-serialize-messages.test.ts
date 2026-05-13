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

import { createEvent, fork, allSettled, serialize } from "@virentia/effector";
import { argumentHistory } from "effector/fixtures";

import { simpleStore } from "./stub/simple-store";
import { sidlessStore } from "./stub/sidless-store";

// Virentia upstream skip reason: Проверяет точный формат error stacks при serialize(scope), завязанный на реализацию Effector.
describe.skip("upstream error-stacks/scope-serialize-messages.test.ts", () => {
  const mapStackTrace = (stacktrace: string) => {
    if (!stacktrace) return [];
    return stacktrace.split("\n").map((line) => {
      const [, , , , , , file] = line.split(" ");
      return file;
    });
  };

  describe("skipVoid error messages", () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    function getErrorStacks() {
      return argumentHistory(consoleErrorSpy).map((e) =>
        e?.message
          ? e.message +
            "\n" +
            mapStackTrace(e.stack)
              .filter((x) => !!x && x.includes("error-stacks"))
              .map((f) => f.split("/").slice(-3).join("/") + "\n")
          : e,
      );
    }

    afterEach(() => {
      consoleErrorSpy.mockClear();
    });

    test("Serialize scope", async () => {
      const scope = fork();

      const event = createEvent();
      simpleStore.on(event, () => 2);
      sidlessStore.on(event, () => 2);
      await allSettled(event, { scope });
      expect(serialize(scope)).toMatchInlineSnapshot(`
    Object {
      "u23wz5": 2,
    }
  `);
      expect(getErrorStacks()).toMatchInlineSnapshot(`
    Array [
      "serialize: One or more stores dont have sids, their values are omitted",
      "store should have sid or \`serialize: ignore\`
    __tests__/error-stacks/scope-serialize-messages.test.ts:43:21)
    ",
    ]
  `);
    });
  });
});
