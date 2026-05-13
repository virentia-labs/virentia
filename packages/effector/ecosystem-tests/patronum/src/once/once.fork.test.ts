/*
 * Copyright (c) 2020 Sergey Sova
 * Copyright (c) 2021 Effector core team
 * SPDX-License-Identifier: MIT
 * Source: https://github.com/effector/patronum
 */

import { allSettled, createEvent, fork, serialize } from "effector";
import { once } from "patronum/once";

it("persists state between scopes", async () => {
  const fn = vi.fn();

  const trigger = createEvent<void>();
  const derived = once(trigger);

  derived.watch(fn);

  const scope1 = fork();
  await allSettled(trigger, { scope: scope1 });

  const scope2 = fork({ values: serialize(scope1) });
  await allSettled(trigger, { scope: scope2 });

  expect(fn).toHaveBeenCalledTimes(1);
});

it("resetting does not leak between scopes", async () => {
  const fn = vi.fn();

  const source = createEvent<void>();
  const reset = createEvent<void>();

  const derived = once({ source, reset });

  derived.watch(fn);

  const triggeredScope = fork();
  const resetScope = fork();

  await allSettled(source, { scope: triggeredScope });
  await allSettled(reset, { scope: resetScope });
  await allSettled(source, { scope: triggeredScope });

  expect(fn).toHaveBeenCalledTimes(1);
});
