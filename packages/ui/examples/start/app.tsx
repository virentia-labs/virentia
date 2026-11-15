/** @jsxImportSource @virentia/ui */
import { f, staticModel } from "@virentia/core/models";
import { action, component, computed } from "@virentia/ui";
import "./style.css";

interface PageData { path: string; greeting: string }
const PageModel = staticModel({
  name: "StartPage", data: { data: f.any(), count: f.number(0) },
  setup(self) {
    const increment = action(() => { self.count.value++; });
    return {
      increment,
      greeting: computed(() => (self.data.value as PageData).greeting),
      path: computed(() => (self.data.value as PageData).path),
    };
  },
});
export default component({
  model: PageModel,
  view: (_props, self) => <main>
    <p class="eyebrow">VIRENTIA / START</p><h1>{self.model.greeting}</h1>
    <p>This page was rendered for <code>{self.model.path}</code> and hydrated in place.</p>
    <button onClick={self.model.increment}>Clicked {self.model.count} times</button>
  </main>,
});
