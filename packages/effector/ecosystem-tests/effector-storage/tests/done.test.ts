/*
 * Copyright (c) 2019 Victor Didenko <yumaa.verdin@gmail.com>
 * SPDX-License-Identifier: MIT
 * Source: https://github.com/yumauri/effector-storage
 */

import type { StorageAdapter } from "effector-storage";
import { createEvent, createStore } from "effector";
import { expect, it, vi } from "vitest";
import { persist } from "effector-storage/core";

//
// Dumb fake adapter
//

const dumbAdapter: StorageAdapter = <T>() => {
  let __: T = 0 as any;
  return {
    get: (): T => __,
    set: (value: T) => {
      __ = value;
    },
  };
};

//
// Tests
//

it("should fire done and finally events", () => {
  const watch = vi.fn();

  const done = createEvent<any>();
  const anyway = createEvent<any>();
  done.watch(watch);
  anyway.watch(watch);

  const $store = createStore(1);
  persist({
    store: $store,
    adapter: dumbAdapter,
    key: "test",
    done,
    finally: anyway,
  });

  expect(watch).toHaveBeenCalledTimes(2);

  // `finally`, get value from storage
  expect(watch.mock.calls[0]).toEqual([
    {
      key: "test",
      keyPrefix: "",
      operation: "get",
      status: "done",
      value: 0,
    },
  ]);

  // `done`, get value from storage
  expect(watch.mock.calls[1]).toEqual([
    {
      key: "test",
      keyPrefix: "",
      operation: "get",
      value: 0,
    },
  ]);
});

it("should return value on successful `set` operation", () => {
  const watch = vi.fn();

  const done = createEvent<any>();
  done.watch(watch);

  const $store = createStore(1);
  persist({ store: $store, adapter: dumbAdapter, key: "test", done });

  expect(watch).toHaveBeenCalledTimes(1);
  expect(watch.mock.calls[0]).toEqual([
    {
      key: "test",
      keyPrefix: "",
      operation: "get",
      value: 0,
    },
  ]);

  // set new value to store
  ($store as any).setState(2);

  expect(watch).toHaveBeenCalledTimes(2);
  expect(watch.mock.calls[1]).toEqual([
    {
      key: "test",
      keyPrefix: "",
      operation: "set",
      value: 2,
    },
  ]);
});
