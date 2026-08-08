// @vitest-environment happy-dom

import { scope, scoped } from "@virentia/core";
import { collection, f, staticModel } from "@virentia/core/models";
import { act, createElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { useModel } from "../../lib";
import { resetAmbientScopeAfterEach } from "../support/ambient-scope-reset";
import { renderWithScope, withScope } from "../support/render-harness";

resetAmbientScopeAfterEach();

// §10.1: no new hooks — `useModel` takes queries, `todos.get(id)` results and
// model definitions (with `keep`). Chains rebuilt every render hit interned
// plans; an epoch bump that does not change the result must NOT re-render.

function declareTodo() {
  return staticModel({
    data: {
      title: f.string(""),
      done: f.boolean(false).indexed(),
      priority: f.number(0).indexed("ord"),
    },
    name: "todo",
  }) as any;
}

const flush = () => act(async () => {});

describe("useModel(query)", () => {
  it("re-renders on set changes from anywhere; skips no-op epoch bumps", async () => {
    const Todo = declareTodo();
    const appScope = scope();
    const todos: any = scoped(appScope, () => collection(Todo));
    const renders: number[] = [];

    const View = (): ReactNode => {
      // the chain is REBUILT every render — plan interning keeps it free (§8)
      const active = useModel(todos.where(Todo.done.eq(false)).sort(Todo.priority.desc)) as any;

      renders.push(active.count);

      return createElement("div", null, String(active.count));
    };

    renderWithScope(appScope, createElement(View));

    expect(renders).toEqual([0]);

    await act(async () => {
      scoped(appScope, () => {
        todos.add({ title: "one", priority: 1 });
      });
    });

    expect(renders).toEqual([0, 1]);

    const t = scoped(appScope, () => todos.get(todos.ids[0]));

    // a write that leaves the result set unchanged — no re-render
    await act(async () => {
      t.title.value = "renamed";
    });

    expect(renders).toEqual([0, 1]);

    await act(async () => {
      t.done.value = true; // leaves the filter → set changes
    });

    expect(renders).toEqual([0, 1, 0]);
  });
});

describe("useModel(todos.get(id))", () => {
  it("renders the entity, follows its writes, resolves aliases, nulls after dispose", async () => {
    const Todo = declareTodo();
    const appScope = scope();
    const todos: any = scoped(appScope, () => collection(Todo));

    scoped(appScope, () => {
      todos.add({ id: "t1", title: "first" });
    });

    const seen: (string | null)[] = [];

    const View = (): ReactNode => {
      const entity = useModel(todos.get("t1")) as any;

      seen.push(entity === null ? null : entity.title.value);

      return createElement("div", null, String(entity?.title.value ?? "gone"));
    };

    renderWithScope(appScope, createElement(View));

    expect(seen).toEqual(["first"]);

    const t = scoped(appScope, () => todos.get("t1"));

    await act(async () => {
      t.title.value = "renamed";
    });

    expect(seen.at(-1)).toBe("renamed");

    await act(async () => {
      t.rebind("server-1"); // the component still holds "t1" — forwarding resolves it
    });

    expect(seen.at(-1)).toBe("renamed");

    await act(async () => {
      todos.remove("server-1");
    });

    await flush();

    expect(seen.at(-1)).toBeNull();
  });
});

describe("useModel(Definition, props, { keep })", () => {
  it("creates through the collection, merges props, disposes on unmount", async () => {
    const Todo = declareTodo();
    const appScope = scope();
    const todos: any = scoped(appScope, () => collection(Todo));

    const View = ({ title }: { title: string }): ReactNode => {
      const m = useModel(Todo, { title }) as any;

      return createElement("div", null, m ? m.title.value : "none");
    };

    const rendered = renderWithScope(appScope, createElement(View, { title: "hello" }));

    expect(todos.count).toBe(1);
    expect(todos.first.title.value).toBe("hello");

    rendered.rerender(withScope(appScope, createElement(View, { title: "renamed" })));
    await flush();

    expect(todos.count).toBe(1); // same instance, props merged
    expect(todos.first.title.value).toBe("renamed");

    rendered.unmount();
    await flush();

    expect(todos.count).toBe(0); // unmount disposed it
  });

  it("keep: unmount keeps the instance, remount finds the singleton and merges", async () => {
    const Todo = declareTodo();
    const appScope = scope();
    const todos: any = scoped(appScope, () => collection(Todo));

    const View = ({ title }: { title: string }): ReactNode => {
      const m = useModel(Todo, { title }, { keep: true }) as any;

      return createElement("div", null, m ? m.title.value : "none");
    };

    const first = renderWithScope(appScope, createElement(View, { title: "v1" }));

    expect(todos.count).toBe(1);

    const keptId = todos.first.id;

    first.unmount();
    await flush();

    expect(todos.count).toBe(1); // survived the unmount (§10.1)

    renderWithScope(appScope, createElement(View, { title: "v2" }));
    await flush();

    expect(todos.count).toBe(1);
    expect(todos.first.id).toBe(keptId); // the SAME instance was found
    expect(todos.first.title.value).toBe("v2"); // and the props were merged

    scoped(appScope, () => todos.remove(keptId)); // explicit end of life
  });

  it("keep with an id targets that instance; keep without an id and several live is a dev error", async () => {
    const Todo = declareTodo();
    const appScope = scope();
    const todos: any = scoped(appScope, () => collection(Todo));

    scoped(appScope, () => {
      todos.add({ id: "a", title: "A" });
      todos.add({ id: "b", title: "B" });
    });

    const ById = (): ReactNode => {
      const m = useModel(Todo, { id: "b" }, { keep: true }) as any;

      return createElement("div", null, m ? m.title.value : "none");
    };

    renderWithScope(appScope, createElement(ById));

    expect(todos.count).toBe(2); // adopted, not created

    const Ambiguous = (): ReactNode => {
      useModel(Todo, {}, { keep: true });

      return null;
    };

    expect(() => renderWithScope(appScope, createElement(Ambiguous))).toThrowError(/ambiguous/);
  });
});
