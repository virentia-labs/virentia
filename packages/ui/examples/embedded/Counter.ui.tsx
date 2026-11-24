/** @jsxImportSource @virentia/ui */
import { f, staticModel } from "@virentia/core/models";
import { action, component, store } from "@virentia/ui";

export const total = store(0);
export const setupCalls = { value: 0 };
const CounterModel = staticModel({
  name: "EmbeddedCounter", data: { label: f.string(), count: f.number(0) },
  setup(self) {
    setupCalls.value++;
    const increment = action(() => { self.count.value++; total.value++; });
    return { increment };
  },
});
export const Counter = component({
  model: CounterModel, keep: true, root: "button",
  view: (_props, self) => <button type="button" data-counter={self.id} onClick={self.model.increment}>
    {self.model.label}: {self.model.count} / total {total}
  </button>,
});
