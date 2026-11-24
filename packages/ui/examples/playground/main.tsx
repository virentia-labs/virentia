/** @jsxImportSource @virentia/ui */
import { children, f, inverse, staticModel } from "@virentia/core/models";
import { action, component, computed, For, reaction, ref, render, scope, scoped, ui } from "@virentia/ui";
import "./style.css";

const EditorModel = staticModel({
  name: "PlaygroundEditor", with: [ui], data: { draft: f.string("") },
  setup(self) {
    const input = ref<HTMLInputElement>();
    const change = action<InputEvent>((event) => {
      self.draft.value = (event.currentTarget as HTMLInputElement).value;
    });
    reaction({ on: self.mounted, run: () => input.value?.focus() });
    return { input, change };
  },
});
const TaskModel = staticModel({
  name: "PlaygroundTask", with: [ui],
  data: { title: f.string(), draft: f.string(""), board: inverse(() => BoardModel.tasks) },
  setup(self) {
    const change = action<InputEvent>((event) => {
      self.draft.value = (event.currentTarget as HTMLInputElement).value;
    });
    const remove = action(() => {
      const relation = self.board as { value: { tasks: { remove(id: string): void | Promise<void> } } | null };
      return relation.value?.tasks.remove(self.id);
    });
    return { change, remove };
  },
});
const BoardModel = staticModel({
  name: "PlaygroundBoard",
  data: { count: f.number(0), visible: f.boolean(true), tasks: children.many(TaskModel), editor: children.one(EditorModel) },
  setup(self) {
    const increment = action(() => { self.count.value++; });
    const decrement = action(() => { self.count.value--; });
    const toggle = action(() => { self.visible.value = !self.visible.value; });
    const add = action(() => { self.tasks.add({ title: "New task" }); });
    const reverse = action(() => {
      const tasks = self.tasks.items.slice().reverse();
      tasks.forEach((task, index) => self.tasks.move(task, index));
    });
    return { increment, decrement, toggle, add, reverse, doubled: computed(() => self.count.value * 2) };
  },
});
const Editor = component({
  model: EditorModel,
  view: (_props, self) => <div class="branch">Model-owned draft <input ref={self.model.input}
    value={self.model.draft} onInput={self.model.change} aria-label="Conditional draft" /></div>,
});
const TaskRow = component({
  model: TaskModel,
  view: (_props, self) => <li><label>{self.model.title}
    <input value={self.model.draft} onInput={self.model.change} placeholder="Type, then reverse the list" />
  </label><button class="quiet" onClick={self.model.remove}>Remove</button></li>,
});
let viewCalls = 0;
const App = component({
  model: BoardModel,
  view(_props, self) {
    viewCalls++;
    const board = self.model;
    function editor() {
      if (!board.visible.value) return <p>The editor is hidden; its model keeps the draft.</p>;
      return <Editor model={board.editor.value!} />;
    }
    return <main>
      <header><span class="eyebrow">VIRENTIA / UI</span><h1>Change state.<br />Keep the DOM.</h1>
        <p>Models own state. Views materialize DOM. Units update existing nodes.</p></header>
      <section><div class="section-heading"><h2>01 / Counter</h2><span class="badge">View calls: {viewCalls}</span></div>
        <div class="counter"><button onClick={board.decrement}>−</button><output data-count>{board.count}</output>
          <button onClick={board.increment}>+</button></div><p>Derived value: <strong data-doubled>{board.doubled}</strong>.</p></section>
      <section><div class="section-heading"><h2>02 / Model collection</h2><div class="actions">
        <button onClick={board.reverse}>Reverse</button><button onClick={board.add}>Add row</button></div></div>
        <p>Input nodes and their drafts move with their model instances. No key matching or tree diff.</p>
        <ul><For each={board.tasks} view={TaskRow} /></ul></section>
      <section><div class="section-heading"><h2>03 / Conditional fragment</h2><button onClick={board.toggle}>Toggle editor</button></div>
        {editor}</section>
      <footer>Native Core models · ordinary JSX · no reactive compiler · no reconciliation</footer>
    </main>;
  },
});
const appScope = scope();
const instance = scoped(appScope, () => BoardModel.create({
  id: "board", tasks: [{ title: "Model-owned state" }, { title: "Persistent DOM" }, { title: "Scoped reactions" }], editor: {},
}));
const dispose = render(() => <App model={instance} />, document.getElementById("app")!, { scope: appScope });
if (import.meta.hot) import.meta.hot.dispose(() => { void dispose(); });
