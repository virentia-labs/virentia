// @vitest-environment happy-dom

import { event, reaction, scope, scoped } from "@virentia/core";
import { f, model, staticModel, type InstanceOf } from "@virentia/core/models";
import { defineComponent, h, nextTick, type PropType } from "vue";
import { describe, expect, it } from "vitest";
import { component, useModel } from "../../lib";
import { mountWithScope } from "../support/mount";

for (const define of [model, staticModel]) {
  describe(`${define.name}.static in Vue`, () => {
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
      const View = defineComponent({
        setup() {
          const counter = useModel(singleton);
          return () =>
            h("button", { onClick: () => counter.value?.add() }, counter.value?.count.value);
        },
      });
      const first = scope({ values: [[singleton.count, 1]] });
      const second = scope({ values: [[singleton.count, 5]] });
      const a = mountWithScope(first, View);
      const b = mountWithScope(second, View);
      try {
        expect(a.text()).toBe("1");
        expect(b.text()).toBe("5");
        await a.find("button").trigger("click");
        expect(a.text()).toBe("2");
        expect(b.text()).toBe("5");
        a.unmount();
        expect(scoped(first, () => singleton.count.value)).toBe(2);
        const remount = mountWithScope(first, View);
        try {
          expect(remount.text()).toBe("2");
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
      const View = defineComponent({
        props: { model: { type: Object as PropType<InstanceOf<typeof Counter>>, required: true } },
        setup: (props) => () => h("span", null, props.model?.count.value),
      });
      const CounterView = component({ model: Counter, view: View });
      const app = scope();
      const mounted = mountWithScope(app, CounterView, { model: singleton });
      const otherMounted = mountWithScope(app, CounterView, { model: other });
      try {
        expect(mounted.text()).toBe("0");
        scoped(app, () => {
          singleton.count.value = 3;
        });
        await nextTick();
        expect(mounted.text()).toBe("3");
        expect(otherMounted.text()).toBe("0");
        expect(scoped(app, () => Counter.instances.count)).toBe(0);
      } finally {
        mounted.unmount();
        otherMounted.unmount();
      }
      expect(scoped(app, () => singleton.count.value)).toBe(3);
    });
  });
}
