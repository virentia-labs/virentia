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

import {
  createEvent,
  createStore,
  sample,
  step,
  createNode,
  createEffect,
} from "@virentia/effector";
import { argumentHistory } from "effector/fixtures";

// Virentia upstream skip reason: Raw kernel tests: createNode, step, launch, computation priority и graphite internals.
describe.skip("upstream kernelEdgeCases.test.ts", () => {
  it("should call watcher as many times, as many store updates occured", () => {
    const fn = vi.fn();
    const e1 = createEvent<string>();
    const e2 = e1.map(() => "e2");
    const st1 = createStore("str")
      .on(e1, (_, x) => x)
      .on(e2, (_, x) => x);

    st1.watch(fn);
    e1("first call");
    e1("second call");
    expect(argumentHistory(fn)).toMatchInlineSnapshot(`
  Array [
    "str",
    "first call",
    "e2",
    "second call",
    "e2",
  ]
`);
  });
  it("should call sampled watcher once during a walk", () => {
    const fn = vi.fn();
    const e1 = createEvent<string>();
    const e2 = e1.map(() => "e2");
    const st1 = createStore("str")
      .on(e1, (_, x) => x)
      .on(e2, (_, x) => x);

    sample(st1).watch(fn);
    e1("first call");
    e1("second call");
    expect(argumentHistory(fn)).toMatchInlineSnapshot(`
  Array [
    "str",
    "e2",
  ]
`);
  });

  it("should avoid data races", () => {
    const fn = vi.fn();
    const routePush = createEvent<string>();

    const history = createStore<string[]>([]).on(routePush, (state, route) => [...state, route]);
    const currentIdx = createStore(-2).on(routePush, () => history.getState().length - 1);

    history.watch(() => {});
    currentIdx.watch(fn);

    routePush("v 1");
    routePush("v 2");
    expect(argumentHistory(fn)).toEqual([-2, 0, 1]);
  });

  it("should not erase sibling branches", () => {
    const fooFn = vi.fn();
    const trigger = createEvent<number>();
    const foo = createStore(0);
    foo.on(trigger, (state, payload) => payload);
    let skipped = false;
    foo.watch((val) => {
      if (!skipped) {
        skipped = true;
        return;
      }
      //@ts-expect-error
      foo.setState(val);
    });

    foo.watch(fooFn);
    trigger(30);
    expect(argumentHistory(fooFn)).toEqual([0, 30]);
  });

  test("watch behavior should be consistent", () => {
    const fn = vi.fn();
    const trigger = createEvent<number>();

    createNode({
      node: [step.run({ fn: () => fn(`watch A`) })],
      parent: [trigger],
    });
    createNode({
      node: [step.compute({ fn: (n) => n }), step.run({ fn: () => fn(`watch B`) })],
      parent: [trigger],
    });
    createNode({
      node: [step.run({ fn: () => fn(`watch C`) })],
      parent: [trigger],
    });
    createNode({
      node: [step.compute({ fn: (n) => fn(`compute`) })],
      parent: [trigger],
    });

    trigger(1);

    expect(argumentHistory(fn)).toMatchInlineSnapshot(`
  Array [
    "compute",
    "watch A",
    "watch B",
    "watch C",
  ]
`);
  });

  test("stale reads", async () => {
    const fn = vi.fn();
    const fx = createEffect((tag: string) => `${tag}/end`);
    const x = createStore([] as (string | boolean)[])
      .on(fx, (words, x) => [...words, x])
      .on(fx.pending, (words, x) => [...words, x])
      .on(fx.doneData, (words, x) => [...words, x]);

    x.watch((upd) => fn(upd.join(", ")));

    await fx("a");
    await fx("b");
    expect(argumentHistory(fn)).toMatchInlineSnapshot(`
  Array [
    "",
    "a",
    "a, true",
    "a, true, a/end",
    "a, true, a/end, false",
    "a, true, a/end, false, b",
    "a, true, a/end, false, b, true",
    "a, true, a/end, false, b, true, b/end",
    "a, true, a/end, false, b, true, b/end, false",
  ]
`);
  });
});
