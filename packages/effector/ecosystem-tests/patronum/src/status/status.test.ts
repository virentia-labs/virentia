/*
 * Copyright (c) 2020 Sergey Sova
 * Copyright (c) 2021 Effector core team
 * SPDX-License-Identifier: MIT
 * Source: https://github.com/effector/patronum
 */

import { createEvent, createEffect } from "effector";
import { argumentHistory, waitFor } from "../../test-library";
import { status } from "patronum/status";

test("change status: initial -> pending -> done", async () => {
  const effect = createEffect<void, void>(() => {
    return new Promise<void>((resolve) => setTimeout(resolve, 100));
  });
  const $status = status({ effect });
  const fn = vi.fn();

  $status.watch(fn);
  expect(argumentHistory(fn)).toMatchInlineSnapshot(`
    [
      "initial",
    ]
  `);

  effect();
  expect(argumentHistory(fn)).toMatchInlineSnapshot(`
    [
      "initial",
      "pending",
    ]
  `);

  await waitFor(effect.finally);
  expect(argumentHistory(fn)).toMatchInlineSnapshot(`
    [
      "initial",
      "pending",
      "done",
    ]
  `);
});

test("change status: initial -> pending -> done (shorthand)", async () => {
  const effect = createEffect<void, void>(() => {
    return new Promise<void>((resolve) => setTimeout(resolve, 100));
  });
  const $status = status(effect);
  const fn = vi.fn();

  $status.watch(fn);
  expect(argumentHistory(fn)).toMatchInlineSnapshot(`
    [
      "initial",
    ]
  `);

  effect();
  expect(argumentHistory(fn)).toMatchInlineSnapshot(`
    [
      "initial",
      "pending",
    ]
  `);

  await waitFor(effect.finally);
  expect(argumentHistory(fn)).toMatchInlineSnapshot(`
    [
      "initial",
      "pending",
      "done",
    ]
  `);
});

test("change status: initial -> pending -> fail", async () => {
  const effect = createEffect({
    handler: () => new Promise<void>((_, reject) => setTimeout(reject, 100)),
  });
  const fn = vi.fn();
  const $status = status({ effect });
  $status.watch(fn);

  effect();
  expect(argumentHistory(fn)).toMatchInlineSnapshot(`
    [
      "initial",
      "pending",
    ]
  `);

  await waitFor(effect.finally);
  expect(argumentHistory(fn)).toMatchInlineSnapshot(`
    [
      "initial",
      "pending",
      "fail",
    ]
  `);
});

test("change status: initial -> pending -> fail -> initial (clear)", async () => {
  const clear = createEvent();
  const effect = createEffect({
    handler: () => new Promise<void>((resolve) => setTimeout(resolve, 100)),
  });
  const $status = status({ effect });
  const fn = vi.fn();

  $status.watch(fn);
  $status.reset(clear);

  effect();
  await waitFor(effect.finally);

  clear();
  expect(argumentHistory(fn)).toMatchInlineSnapshot(`
    [
      "initial",
      "pending",
      "done",
      "initial",
    ]
  `);
});

test("set default status effect", async () => {
  const effect = createEffect({
    handler: () => new Promise<void>((resolve) => setTimeout(resolve, 100)),
  });
  const $status = status({ effect, defaultValue: "pending" });
  const fn = vi.fn();

  $status.watch(fn);

  effect();
  await waitFor(effect.finally);

  expect(argumentHistory(fn)).toMatchInlineSnapshot(`
    [
      "pending",
      "done",
    ]
  `);
});
