/** @jsxImportSource @virentia/ui */
import { collection, f, staticModel, type InstanceOf } from "@virentia/core/models";
import { For, action, computed, reaction, render, store, type ComponentLifecycle } from "@virentia/ui";
import "./style.css";

const Task = staticModel({
  name: "PlaygroundTask",
  data: {
    title: f.string(),
    rank: f.number(0).indexed("ord"),
  },
});
type TaskInstance = InstanceOf<typeof Task>;

let componentSetups = 0;
let rowSetups = 0;
let rowDisposals = 0;
const metrics = store({ rowsMounted: 0, rowsRemoved: 0 });

type TaskRowProps = { task: () => TaskInstance; index: () => number; remove: () => void };

function TaskRow(props: TaskRowProps, { unmounted }: ComponentLifecycle<TaskRowProps>) {
  rowSetups++;
  const remove = action(() => props.remove());
  // Reads used for mutation are intentionally not JSX bindings.
  metrics.value = { rowsMounted: rowSetups, rowsRemoved: rowDisposals };
  reaction({
    on: unmounted,
    run() {
      rowDisposals++;
      metrics.value = { rowsMounted: rowSetups, rowsRemoved: rowDisposals };
    },
  });
  return (
    <li>
      <span class="position">{props.index() + 1}</span>
      <label>
        {props.task().title.value}
        <input
          aria-label={`Draft for ${props.task().title.value}`}
          placeholder="Type a draft; then reverse the list"
        />
      </label>
      <button class="quiet" onClick={remove}>
        Remove
      </button>
    </li>
  );
}

function App() {
  componentSetups++;
  const count = store(0);
  const doubled = computed(() => count.value * 2);
  const increment = action(() => {
    count.value++;
  });
  const decrement = action(() => {
    count.value--;
  });
  const visible = store(true);
  const tasks = collection(Task);
  if (tasks.count === 0) {
    tasks.add([
      { id: "task-1", title: "Ordinary JSX", rank: 1 },
      { id: "task-2", title: "Persistent DOM", rank: 2 },
      { id: "task-3", title: "Scoped reactivity", rank: 3 },
    ]);
  }
  const orderedTasks = tasks.sort(Task.rank.asc);
  let nextTaskNumber = 4;
  const reverseTasks = action(() => {
    const ordered = orderedTasks.toArray();
    for (let index = 0; index < ordered.length; index++) {
      ordered[index]!.rank.value = ordered.length - index;
    }
  });
  const addTask = action(() => {
    const ordered = orderedTasks.toArray();
    const last = ordered[ordered.length - 1];
    const taskNumber = nextTaskNumber++;
    tasks.add({
      id: `task-${taskNumber}`,
      title: `New row ${taskNumber}`,
      rank: last ? last.rank.value + 1 : 1,
    });
  });

  return (
    <main>
      <header>
        <span class="eyebrow">VIRENTIA / UI · EXPERIMENTAL</span>
        <h1>
          Change the value.
          <br />
          Keep the view.
        </h1>
        <p>
          JSX compiles into live bindings. Components set up once; state changes update the DOM in
          place.
        </p>
      </header>
      <section aria-labelledby="counter-title">
        <div class="section-heading">
          <h2 id="counter-title">01 / Counter</h2>
          <span class="badge">App setups: {componentSetups}</span>
        </div>
        <div class="counter">
          <button aria-label="Decrease" onClick={decrement}>
            −
          </button>
          <output data-count>{count.value}</output>
          <button aria-label="Increase" onClick={increment}>
            +
          </button>
        </div>
        <p>
          Derived value: <strong data-doubled>{doubled.value}</strong>. This text updates without
          calling App again.
        </p>
      </section>
      <section aria-labelledby="list-title">
        <div class="section-heading">
          <h2 id="list-title">02 / Keyed list</h2>
          <div class="actions">
            <button onClick={reverseTasks}>Reverse</button>
            <button onClick={addTask}>Add row</button>
          </div>
        </div>
        <p>
          Write into an input and reverse the list. Each input and its draft travel with their row.
        </p>
        <ul>
          <For each={orderedTasks} fallback={<p>No rows. Add one to mount it.</p>}>
            {(task, index) => (
              <TaskRow task={task} index={index} remove={() => tasks.remove(task().id)} />
            )}
          </For>
        </ul>
        <p class="metrics">
          Row setups: {metrics.value.rowsMounted} · Row cleanups: {metrics.value.rowsRemoved}
        </p>
      </section>
      <section aria-labelledby="branch-title">
        <div class="section-heading">
          <h2 id="branch-title">03 / Conditional branch</h2>
          <button onClick={() => (visible.value = !visible.value)}>Toggle branch</button>
        </div>
        {visible.value ? (
          <div class="branch">
            This branch has its own lifetime.{" "}
            <input
              aria-label="Conditional draft"
              placeholder="Unmounting this branch clears the draft"
            />
          </div>
        ) : (
          <p>The branch is unmounted and its subscriptions are disposed.</p>
        )}
      </section>
      <footer>Virentia stores + scopes · compiled JSX · direct DOM bindings</footer>
    </main>
  );
}

const dispose = render(() => <App />, document.getElementById("app")!);
if (import.meta.hot) import.meta.hot.dispose(dispose);
