/*
 * Copyright (c) 2020 Sergey Sova
 * Copyright (c) 2021 Effector core team
 * SPDX-License-Identifier: MIT
 * Source: https://github.com/effector/patronum
 */

import { performance } from "node:perf_hooks";
import { is } from "effector";
import { vi } from "vitest";

export function waitFor(unit: any) {
  return new Promise((resolve) => {
    const unsubscribe = unit.watch((payload: unknown) => {
      resolve(payload);
      unsubscribe();
    });
  });
}

export function argumentHistory(fn: any) {
  return fn.mock.calls.map(([value]: [unknown]) => value);
}

export function argumentsHistory(fn: any) {
  return fn.mock.calls;
}

export function time() {
  const start = performance.now();

  return {
    diff: () => performance.now() - start,
  };
}

export function toBeCloseWithThreshold(received: number, expected: number, threshold: number) {
  const minimum = expected - threshold;
  const maximum = expected + threshold;

  if (received < minimum) {
    return {
      pass: false,
      message: () =>
        `expected ${received} to be close to ${expected}, but it is smaller that minimum ${minimum} with threshold ${threshold}`,
    };
  }

  if (received > maximum) {
    return {
      pass: false,
      message: () =>
        `expected ${received} to be close to ${expected}, but it is bigger that maximum ${maximum} with threshold ${threshold}`,
    };
  }

  return {
    pass: true,
    message: () => `expected ${received} to be close to ${expected}, it is ok`,
  };
}

export const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function watch(unit: any) {
  const fn = vi.fn();
  unit.watch(fn);
  return fn;
}

export function monitor(units: any[]) {
  const fn = vi.fn();

  units.forEach((unit) => {
    if (is.store(unit)) {
      unit.watch((value: unknown) => fn(`Store ${unit.shortName}`, value));
    }

    if (is.event(unit)) {
      unit.watch((value: unknown) => fn(`Event ${unit.shortName}`, value));
    }

    if (is.effect(unit)) {
      unit.watch((value: unknown) => fn(`Effect ${unit.shortName}`, value));
      unit.done.watch((value: unknown) => fn(`Effect ${unit.shortName}.done`, value));
      unit.fail.watch((value: unknown) => fn(`Effect ${unit.shortName}.fail`, value));
    }
  });

  return () => argumentsHistory(fn);
}
