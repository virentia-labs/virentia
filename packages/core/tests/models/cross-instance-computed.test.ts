import { expect, it } from "vitest";
import { computed, scope, scoped } from "../../lib";
import { children, f, staticModel } from "../../lib/models";
import { collection } from "../../lib/models/collection";

it("keeps model-owned computed values reactive when they read child instance facades", () => {
  const Task = staticModel({ data: { count: f.number(0) } });
  const Board = staticModel({
    data: { tasks: children.many(Task) },
    setup(self) { return { total: computed(() => self.tasks.items.reduce((sum, task) => sum + task.count.value, 0)) }; },
  });
  const app = scope();
  const board = scoped(app, () => collection(Board).add({ tasks: [{ count: 1 }, { count: 2 }] }));
  expect(board.total.value).toBe(3);
  const task = board.tasks.items[0];
  task.count.value = 10;
  expect(board.total.value).toBe(12);
});

// A global computed over instances that live in their own scopes reads every
// field through a cross-scope bridge. The bridge is the read's only dependency:
// tracking the shared field node as well used to promote it to a global edge
// once the computed was observed scope-lessly, so each write re-ran the computed
// (and notified the subscriber) again in the home scope of every instance it
// had been evaluated in — one more notification with every write.
it("notifies a scope-less observer of a computed over instances once per field write", () => {
  const Todo = staticModel({ name: "CrossScopeTodo", data: { done: f.boolean(false) } });
  let runs = 0;
  const doneCount = computed(() => {
    runs += 1;
    let count = 0;
    for (const todo of Todo.instances) if (todo.done.value) count += 1;
    return count;
  });
  const app = scope();
  const todos = scoped(app, () =>
    Todo.create(Array.from({ length: 5 }, (_, index) => ({ id: `todo-${index}` }))),
  );
  scoped(app, () => doneCount.value);
  const seen: number[] = [];
  doneCount.subscribe((value) => seen.push(value));

  const writes: [number, boolean][] = [
    [0, true],
    [1, true],
    [2, true],
    [0, false],
  ];
  const runsPerWrite: number[] = [];
  for (const [index, done] of writes) {
    runs = 0;
    scoped(app, () => {
      todos[index].done.value = done;
    });
    runsPerWrite.push(runs);
  }

  expect(seen).toEqual([1, 2, 3, 2]);
  // The field's bridge and the collection's version each invalidate the
  // computed once, in the application scope only — however many writes came
  // before.
  expect(runsPerWrite).toEqual([2, 2, 2, 2]);
  expect(scoped(app, () => doneCount.value)).toBe(2);
});
