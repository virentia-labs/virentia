/*
 * Copyright (c) 2023 Igor Kamyşev
 * SPDX-License-Identifier: MIT
 * Source: https://github.com/effector/farfetched
 */

import { describe, expect, test, vi } from "vitest";

import { createMutation } from "@farfetched/core";
import { createQuery } from "@farfetched/core";

describe("@@unitShape protocol returns same object for every call", () => {
  test("query", () => {
    const query = createQuery({ handler: vi.fn() });

    expect(query["@@unitShape"]()).toBe(query["@@unitShape"]());
  });

  test("mutation", () => {
    const mutation = createMutation({ handler: vi.fn() });

    expect(mutation["@@unitShape"]()).toBe(mutation["@@unitShape"]());
  });
});
