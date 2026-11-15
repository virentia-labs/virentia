// @vitest-environment happy-dom

import { event, reaction, scope, scoped } from "@virentia/core";
import { f, model, staticModel, type InstanceOf } from "@virentia/core/models";
import { act } from "@testing-library/react";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { component, useModel } from "../../lib";
import { renderWithScope } from "../support/render-harness";

for (const define of [model, staticModel]) {
  describe(`${define.name}.static in React`, () => {
    it("resolves the same graph independently in two providers and survives unmount", async () => {
      const Counter = define({
        data: { count: f.number(0) },
        setup(self) {
          const add = event<void>();
          reaction({
            on: add,
            run: () => {
              self.count.value++;
            },
          });
          return { add };
        },
      });
      const singleton = Counter.static();
      const View = () => {
        const counter = useModel(singleton);
        return createElement("button", { onClick: () => counter?.add() }, counter?.count.value);
      };
      const first = scope({ values: [[singleton.count, 1]] });
      const second = scope({ values: [[singleton.count, 5]] });
      const a = renderWithScope(first, createElement(View));
      const b = renderWithScope(second, createElement(View));
      try {
        expect(a.container.textContent).toBe("1");
        expect(b.container.textContent).toBe("5");
        await act(async () => {
          a.container.querySelector("button")!.click();
        });
        expect(a.container.textContent).toBe("2");
        expect(b.container.textContent).toBe("5");
        a.unmount();
        expect(scoped(first, () => singleton.count.value)).toBe(2);
        const remount = renderWithScope(first, createElement(View));
        try {
          expect(remount.container.textContent).toBe("2");
        } finally {
          remount.unmount();
        }
      } finally {
        a.unmount();
        b.unmount();
      }
    });

    it("accepts a singleton as a controlled component model", async () => {
      const Counter = define({ data: { count: f.number(0) } });
      const singleton = Counter.static();
      const other = Counter.static();
      const View = ({ model }: { model: InstanceOf<typeof Counter> }) =>
        createElement("span", null, model?.count.value);
      const CounterView = component({ model: Counter, view: View });
      const app = scope();
      const mounted = renderWithScope(app, createElement(CounterView, { model: singleton }));
      const otherMounted = renderWithScope(app, createElement(CounterView, { model: other }));
      try {
        expect(mounted.container.textContent).toBe("0");
        await act(async () => {
          scoped(app, () => {
            singleton.count.value = 3;
          });
        });
        expect(mounted.container.textContent).toBe("3");
        expect(otherMounted.container.textContent).toBe("0");
        expect(scoped(app, () => Counter.instances.count)).toBe(0);
      } finally {
        mounted.unmount();
        otherMounted.unmount();
      }
      expect(scoped(app, () => singleton.count.value)).toBe(3);
    });
  });
}
