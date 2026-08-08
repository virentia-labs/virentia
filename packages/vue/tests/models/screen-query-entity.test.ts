// @vitest-environment happy-dom

import { scope, scoped } from "@virentia/core";
import { collection, f, staticModel } from "@virentia/core/models";
import { defineComponent, h, nextTick, ref } from "vue";
import { afterEach, describe, expect, it } from "vitest";
import { component, useModel } from "../../lib";
import { mountWithScope, unmountAll } from "../support/mount";

afterEach(() => unmountAll());

// §10.2 — the React mirror: `useModel` takes queries, `todos.get(id)` results
// and model definitions (with `keep`); `component({ model: Definition })`.

function declareTodo() {
  return staticModel({
    data: { title: f.string(""), done: f.boolean(false).indexed() },
    name: "todo",
  }) as any;
}

describe("useModel(query)", () => {
  it("a template over query.count follows adds and writes from anywhere", async () => {
    const Todo = declareTodo();
    const appScope = scope();
    const todos: any = scoped(appScope, () => collection(Todo));

    const View = defineComponent({
      setup() {
        const active = useModel(todos.where(Todo.done.eq(false))) as any;

        return () => h("div", null, String(active.value.count));
      },
    });

    const wrapper = mountWithScope(appScope, View);

    expect(wrapper.text()).toBe("0");

    scoped(appScope, () => {
      todos.add({ title: "one" });
    });
    await nextTick();

    expect(wrapper.text()).toBe("1");

    scoped(appScope, () => {
      todos.first.done.value = true;
    });
    await nextTick();

    expect(wrapper.text()).toBe("0");
  });
});

describe("useModel(todos.get(id))", () => {
  it("follows writes, resolves aliases after rebind, nulls after dispose", async () => {
    const Todo = declareTodo();
    const appScope = scope();
    const todos: any = scoped(appScope, () => collection(Todo));

    scoped(appScope, () => {
      todos.add({ id: "t1", title: "first" });
    });

    const View = defineComponent({
      setup() {
        const entity = useModel(todos.get("t1")) as any;

        return () => h("div", null, entity.value === null ? "gone" : entity.value.title.value);
      },
    });

    const wrapper = mountWithScope(appScope, View);

    expect(wrapper.text()).toBe("first");

    const t = scoped(appScope, () => todos.get("t1"));

    t.title.value = "renamed";
    await nextTick();

    expect(wrapper.text()).toBe("renamed");

    t.rebind("server-1");
    await nextTick();

    expect(wrapper.text()).toBe("renamed"); // the held reference is still alive

    todos.remove("server-1");
    await nextTick();

    expect(wrapper.text()).toBe("gone");
  });
});

describe("useModel(Definition, props, { keep })", () => {
  it("creates through the collection, merges reactive props, disposes on unmount", async () => {
    const Todo = declareTodo();
    const appScope = scope();
    const todos: any = scoped(appScope, () => collection(Todo));
    const title = ref("hello");

    const View = defineComponent({
      setup() {
        const m = useModel(Todo, () => ({ title: title.value })) as any;

        return () => h("div", null, m.value ? m.value.title.value : "none");
      },
    });

    const wrapper = mountWithScope(appScope, View);

    expect(todos.count).toBe(1);
    expect(wrapper.text()).toBe("hello");

    title.value = "renamed";
    await nextTick();
    await nextTick();

    expect(todos.count).toBe(1);
    expect(todos.first.title.value).toBe("renamed");

    wrapper.unmount();

    expect(todos.count).toBe(0);
  });

  it("keep: survives the unmount, the remount finds the singleton and merges", async () => {
    const Todo = declareTodo();
    const appScope = scope();
    const todos: any = scoped(appScope, () => collection(Todo));

    const View = defineComponent({
      props: { title: { type: String, required: true } },
      setup(props) {
        const m = useModel(Todo, () => ({ title: props.title }), { keep: true }) as any;

        return () => h("div", null, m.value ? m.value.title.value : "none");
      },
    });

    const first = mountWithScope(appScope, View, { title: "v1" });

    expect(todos.count).toBe(1);

    const keptId = todos.first.id;

    first.unmount();

    expect(todos.count).toBe(1); // survived (§10.1)

    mountWithScope(appScope, View, { title: "v2" });
    await nextTick();

    expect(todos.count).toBe(1);
    expect(todos.first.id).toBe(keptId);
    expect(todos.first.title.value).toBe("v2");

    scoped(appScope, () => todos.remove(keptId));
  });
});

describe("component({ model: Definition })", () => {
  it("renders the instance and disposes on unmount; create() is controlled", async () => {
    const Todo = declareTodo();
    const appScope = scope();
    const todos: any = scoped(appScope, () => collection(Todo));

    const View = defineComponent({
      props: { model: { type: Object, required: false } },
      setup(props) {
        return () => h("div", null, props.model ? (props.model as any).title.value : "none");
      },
    });

    const TodoCard = component({ model: Todo, view: View } as any);
    const wrapper = mountWithScope(appScope, TodoCard as any, { title: "hello" });

    expect(todos.count).toBe(1);
    expect(wrapper.text()).toBe("hello");

    scoped(appScope, () => {
      todos.first.title.value = "renamed";
    });
    await nextTick();

    expect(wrapper.text()).toBe("renamed");

    wrapper.unmount();

    expect(todos.count).toBe(0);

    // controlled instance: created by the parent, never disposed by the view
    const controlled: any = scoped(appScope, () => (TodoCard as any).create({ title: "ctrl" }));
    const second = mountWithScope(appScope, TodoCard as any, { model: controlled });

    expect(second.text()).toBe("ctrl");

    second.unmount();

    expect(controlled.alive).toBe(true);
  });
});
