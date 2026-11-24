/** @jsxImportSource @virentia/ui */
import { f, staticModel } from "@virentia/core/models";
import { component, computed, store, type Binding } from "../../lib";
const Model = staticModel({ data: { count: f.number(0) }, setup(self) {
  return { text: computed(() => String(self.count.value)), disabled: computed(() => self.count.value === 0) };
} });
const Counter = component({ model: Model, view: (_props, self) => {
  const text: Binding<string> = self.model.text;
  return <input value={text} disabled={self.model.disabled} style={{ opacity: self.model.count }} />;
} });
<Counter />;
// @ts-expect-error an input value cannot be a boolean store
<input value={store(false)} />;
