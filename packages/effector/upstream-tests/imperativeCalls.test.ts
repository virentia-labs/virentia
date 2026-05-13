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

import { createEvent, sample, createStore, combine } from "@virentia/effector";

let warn: MockInstance<(...args: [message?: any, ...optionalParams: any[]]) => void>;
beforeEach(() => {
  warn = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
});

function getWarning() {
  return warn.mock.calls.map(([msg]) => msg)[0];
}

// Virentia upstream skip reason: Проверяет точные Effector diagnostics для imperative calls from pure functions; это не потребительский runtime contract Virentia.
describe.skip("store", () => {
  test(".on", () => {
    const trigger = createEvent();
    const event = createEvent();
    const $x = createStore(0).on(trigger, (x) => {
      event();
    });
    trigger();
    expect(getWarning()).toMatchInlineSnapshot(
      `[Error: [event] unit 'event': unit call from pure function is not supported, use operators like sample instead]`,
    );
  });
  test(".map", () => {
    const trigger = createEvent();
    const event = createEvent();
    const $x = createStore(0).on(trigger, (x) => x + 1);
    const $y = $x.map((x) => {
      event();
      return x;
    });
    trigger();
    expect(getWarning()).toMatchInlineSnapshot(
      `[Error: [event] unit 'event': unit call from pure function is not supported, use operators like sample instead]`,
    );
  });
  test("updateFilter", () => {
    const trigger = createEvent();
    const event = createEvent();
    const $x = createStore(0, {
      updateFilter() {
        event();
        return true;
      },
    }).on(trigger, (x) => x + 1);
    trigger();
    expect(getWarning()).toMatchInlineSnapshot(
      `[Error: [event] unit 'event': unit call from pure function is not supported, use operators like sample instead]`,
    );
  });
});

// Virentia upstream skip reason: Проверяет точные Effector diagnostics для imperative calls from pure functions; это не потребительский runtime contract Virentia.
describe.skip("event", () => {
  test(".map", () => {
    const event = createEvent();
    const x = createEvent();
    const y = x.map(() => {
      event();
    });
    x();
    expect(getWarning()).toMatchInlineSnapshot(
      `[Error: [event] unit 'event': unit call from pure function is not supported, use operators like sample instead]`,
    );
  });
  test(".prepend", () => {
    const event = createEvent();
    const y = createEvent();
    const x = y.prepend(() => {
      event();
    });
    x();
    expect(getWarning()).toMatchInlineSnapshot(
      `[Error: [event] unit 'event': unit call from pure function is not supported, use operators like sample instead]`,
    );
  });
  test(".filterMap", () => {
    const event = createEvent();
    const x = createEvent();
    const y = x.filterMap(() => {
      event();
    });
    x();
    expect(getWarning()).toMatchInlineSnapshot(
      `[Error: [event] unit 'event': unit call from pure function is not supported, use operators like sample instead]`,
    );
  });
});

// Virentia upstream skip reason: Проверяет точные Effector diagnostics для imperative calls from pure functions; это не потребительский runtime contract Virentia.
test.skip("combine", () => {
  const trigger = createEvent();
  const event = createEvent();
  const $x = createStore(0).on(trigger, (x) => x + 1);
  const $comb = combine($x, (x) => {
    event();
    return x;
  });
  trigger();
  expect(getWarning()).toMatchInlineSnapshot(
    `[Error: [event] unit 'event': unit call from pure function is not supported, use operators like sample instead]`,
  );
});

// Virentia upstream skip reason: Проверяет точные Effector diagnostics для imperative calls from pure functions; это не потребительский runtime contract Virentia.
describe.skip("sample", () => {
  test("fn", () => {
    const trigger = createEvent();
    const event = createEvent();
    sample({
      clock: trigger,
      fn() {
        event();
      },
    });
    trigger();
    expect(getWarning()).toMatchInlineSnapshot(
      `[Error: [event] unit 'event': unit call from pure function is not supported, use operators like sample instead]`,
    );
  });
  test("filter", () => {
    const trigger = createEvent();
    const event = createEvent();
    sample({
      clock: trigger,
      filter() {
        event();
        return true;
      },
    });
    trigger();
    expect(getWarning()).toMatchInlineSnapshot(
      `[Error: [event] unit 'event': unit call from pure function is not supported, use operators like sample instead]`,
    );
  });
});
