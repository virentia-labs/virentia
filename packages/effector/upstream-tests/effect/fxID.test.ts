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
  attach,
  sample,
  createEvent,
  createEffect,
  Unit,
  Node,
  step,
  allSettled,
  fork,
} from "@virentia/effector";

function getNode(unit: Unit<any>): Node {
  //@ts-expect-error
  return unit.graphite || unit;
}

// Virentia upstream skip reason: Проверяет внутренний стек Effector через graphite/Node/step и stack.meta.fxID; это не внешний API потребителя.
describe.skip("upstream effect/fxID.test.ts", () => {
  describe("plain effect support", () => {
    test("fxID in fx seq", async () => {
      const fx = createEffect(() => {});
      let fxID: any;
      getNode(fx).seq.push(
        step.compute({
          fn(data, _, stack) {
            fxID = stack.meta?.fxID;
            return data;
          },
        }),
      );
      await fx();
      expect(typeof fxID).toBe("string");
    });
    test("fxID in fx.finally seq", async () => {
      const fx = createEffect(() => {});
      let fxID: any;
      getNode(fx.finally).seq.push(
        step.compute({
          fn(data, _, stack) {
            fxID = stack.meta?.fxID;
            return data;
          },
        }),
      );
      await fx();
      expect(typeof fxID).toBe("string");
    });
    test("fxID in fx.done seq", async () => {
      const fx = createEffect(() => {});
      let fxID: any;
      getNode(fx.done).seq.push(
        step.compute({
          fn(data, _, stack) {
            const finallyStack = stack.parent?.parent;
            fxID = finallyStack?.meta?.fxID;
            return data;
          },
        }),
      );
      await fx();
      expect(typeof fxID).toBe("string");
    });
    test("fxID in fx.doneData seq", async () => {
      const fx = createEffect(() => {});
      let fxID: any;
      getNode(fx.doneData).seq.push(
        step.compute({
          fn(data, _, stack) {
            const doneStack = stack.parent?.parent;
            const finallyStack = doneStack?.parent?.parent;
            fxID = finallyStack?.meta?.fxID;
            return data;
          },
        }),
      );
      await fx();
      expect(typeof fxID).toBe("string");
    });
  });

  describe("attach support", () => {
    describe("attached effect", () => {
      test("fxID in fx seq", async () => {
        const fx = attach({ effect: createEffect(() => {}) });
        let fxID: any;
        getNode(fx).seq.push(
          step.compute({
            fn(data, _, stack) {
              fxID = stack.meta?.fxID;
              return data;
            },
          }),
        );
        await fx();
        expect(typeof fxID).toBe("string");
      });
      test("fxID in fx.finally seq", async () => {
        const fx = attach({ effect: createEffect(() => {}) });
        let fxID: any;
        getNode(fx.finally).seq.push(
          step.compute({
            fn(data, _, stack) {
              fxID = stack.meta?.fxID;
              return data;
            },
          }),
        );
        await fx();
        expect(typeof fxID).toBe("string");
      });
      test("fxID in fx.done seq", async () => {
        const fx = attach({ effect: createEffect(() => {}) });
        let fxID: any;
        getNode(fx.done).seq.push(
          step.compute({
            fn(data, _, stack) {
              const finallyStack = stack.parent?.parent;
              fxID = finallyStack?.meta?.fxID;
              return data;
            },
          }),
        );
        await fx();
        expect(typeof fxID).toBe("string");
      });
      test("fxID in fx.doneData seq", async () => {
        const fx = attach({ effect: createEffect(() => {}) });
        let fxID: any;
        getNode(fx.doneData).seq.push(
          step.compute({
            fn(data, _, stack) {
              const doneStack = stack.parent?.parent;
              const finallyStack = doneStack?.parent?.parent;
              fxID = finallyStack?.meta?.fxID;
              return data;
            },
          }),
        );
        await fx();
        expect(typeof fxID).toBe("string");
      });
    });
    describe("inner effect", () => {
      test("fxID in fx seq", async () => {
        const fx = createEffect(() => {});
        const attached = attach({ effect: fx });
        let fxID: any;
        getNode(fx).seq.push(
          step.compute({
            fn(data, _, stack) {
              fxID = stack.meta?.fxID;
              return data;
            },
          }),
        );
        await attached();
        expect(typeof fxID).toBe("string");
      });
      test("fxID in fx.finally seq", async () => {
        const fx = createEffect(() => {});
        const attached = attach({ effect: fx });
        let fxID: any;
        getNode(fx.finally).seq.push(
          step.compute({
            fn(data, _, stack) {
              fxID = stack.meta?.fxID;
              return data;
            },
          }),
        );
        await attached();
        expect(typeof fxID).toBe("string");
      });
      test("fxID in fx.done seq", async () => {
        const fx = createEffect(() => {});
        const attached = attach({ effect: fx });
        let fxID: any;
        getNode(fx.done).seq.push(
          step.compute({
            fn(data, _, stack) {
              const finallyStack = stack.parent?.parent;
              fxID = finallyStack?.meta?.fxID;
              return data;
            },
          }),
        );
        await attached();
        expect(typeof fxID).toBe("string");
      });
      test("fxID in fx.doneData seq", async () => {
        const fx = createEffect(() => {});
        const attached = attach({ effect: fx });
        let fxID: any;
        getNode(fx.doneData).seq.push(
          step.compute({
            fn(data, _, stack) {
              const doneStack = stack.parent?.parent;
              const finallyStack = doneStack?.parent?.parent;
              fxID = finallyStack?.meta?.fxID;
              return data;
            },
          }),
        );
        await attached();
        expect(typeof fxID).toBe("string");
      });
    });
  });

  describe("computation chain support", () => {
    test("fxID in fx seq", async () => {
      const trigger = createEvent();
      const fx = createEffect(() => {});
      sample({ clock: trigger, target: fx });
      let fxID: any;
      getNode(fx).seq.push(
        step.compute({
          fn(data, _, stack) {
            fxID = stack.meta?.fxID;
            return data;
          },
        }),
      );
      await allSettled(trigger, { scope: fork() });
      expect(typeof fxID).toBe("string");
    });
    test("fxID in fx.finally seq", async () => {
      const trigger = createEvent();
      const fx = createEffect(() => {});
      sample({ clock: trigger, target: fx });
      let fxID: any;
      getNode(fx.finally).seq.push(
        step.compute({
          fn(data, _, stack) {
            fxID = stack.meta?.fxID;
            return data;
          },
        }),
      );
      await allSettled(trigger, { scope: fork() });
      expect(typeof fxID).toBe("string");
    });
    test("fxID in fx.done seq", async () => {
      const trigger = createEvent();
      const fx = createEffect(() => {});
      sample({ clock: trigger, target: fx });
      let fxID: any;
      getNode(fx.done).seq.push(
        step.compute({
          fn(data, _, stack) {
            const finallyStack = stack.parent?.parent;
            fxID = finallyStack?.meta?.fxID;
            return data;
          },
        }),
      );
      await allSettled(trigger, { scope: fork() });
      expect(typeof fxID).toBe("string");
    });
    test("fxID in fx.doneData seq", async () => {
      const trigger = createEvent();
      const fx = createEffect(() => {});
      sample({ clock: trigger, target: fx });
      let fxID: any;
      getNode(fx.doneData).seq.push(
        step.compute({
          fn(data, _, stack) {
            const doneStack = stack.parent?.parent;
            const finallyStack = doneStack?.parent?.parent;
            fxID = finallyStack?.meta?.fxID;
            return data;
          },
        }),
      );
      await allSettled(trigger, { scope: fork() });
      expect(typeof fxID).toBe("string");
    });
  });
});
