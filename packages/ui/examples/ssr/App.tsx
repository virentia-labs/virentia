/** @jsxImportSource @virentia/ui */
import { f, staticModel } from "@virentia/core/models";
import { action, component, computed } from "@virentia/ui";

const ProfileModel = staticModel({
  name: "SSRProfile", data: { label: f.string(), initialText: f.string() },
  setup(self) {
    const change = action<InputEvent>((event) => {
      self.initialText.value = (event.currentTarget as HTMLInputElement).value;
    });
    const greeting = computed(() => self.initialText.value || "stranger");
    return { change, greeting };
  },
});
const ProfileField = component({
  model: ProfileModel,
  view: (_props, self) => {
    const id = self.elementId("field");
    return <div class="field"><label htmlFor={id}>{self.model.label}</label>
      <input id={id} value={self.model.initialText} onInput={self.model.change} />
      <p>Hello, <strong>{self.model.greeting}</strong>.</p></div>;
  },
});
const AppModel = staticModel({
  name: "SSRApp", data: { initialCount: f.number(0) },
  setup(self) {
    const increment = action(() => { self.initialCount.value++; });
    const decrement = action(() => { self.initialCount.value--; });
    return { increment, decrement };
  },
});
export const App = component({
  model: AppModel,
  view: (_props, self) => <main>
    <header><p class="eyebrow">VIRENTIA / UI · SSR + HYDRATION</p><h1>Sent as HTML.<br />Kept as DOM.</h1>
      <p class="intro">Hydration attaches bindings to existing nodes. Model state is restored before view.</p></header>
    <section aria-labelledby="counter-heading"><h2 id="counter-heading">A request-scoped counter</h2>
      <div class="counter"><button aria-label="Decrease" onClick={self.model.decrement}>−</button>
        <output data-count>{self.model.initialCount}</output><button aria-label="Increase" onClick={self.model.increment}>+</button></div>
      <p>The browser initializer is 0. The server snapshot starts at 7.</p></section>
    <section aria-labelledby="fields-heading"><h2 id="fields-heading">Two independent model instances</h2>
      <div class="fields"><ProfileField label="First name" initialText="Ada" /><ProfileField label="Second name" initialText="Linus" /></div>
      <label htmlFor="ssr-notes">Uncontrolled notes</label><textarea id="ssr-notes" defaultValue={"\nNotes <&\rsecond line"} /></section>
  </main>,
});
