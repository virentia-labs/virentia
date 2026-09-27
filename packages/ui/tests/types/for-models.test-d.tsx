/** @jsxImportSource @virentia/ui */
import { collection, f, staticModel, type InstanceOf } from "@virentia/core/models";
import { expectTypeOf, test } from "vitest";
import { For } from "../../lib";

test("For infers model instances from a definition, collection and query", () => {
  const Todo = staticModel({
    data: { title: f.string(), rank: f.number(0).indexed("ord") },
  });
  const todos = collection(Todo);
  const ordered = todos.sort(Todo.rank.asc);

  <For each={Todo} by={(todo) => todo.id}>
    {(todo, index) => {
      expectTypeOf(todo()).toEqualTypeOf<InstanceOf<typeof Todo>>();
      expectTypeOf(todo().title.value).toEqualTypeOf<string>();
      expectTypeOf(index()).toEqualTypeOf<number>();
      return <li>{todo().title.value}</li>;
    }}
  </For>;

  <For each={todos}>
    {(todo) => {
      expectTypeOf(todo()).toEqualTypeOf<InstanceOf<typeof Todo>>();
      expectTypeOf(todo().rank.value).toEqualTypeOf<number>();
      return <li>{todo().title.value}</li>;
    }}
  </For>;

  <For each={ordered}>
    {(todo) => {
      expectTypeOf(todo()).toEqualTypeOf<InstanceOf<typeof Todo>>();
      return <li>{todo().title.value}</li>;
    }}
  </For>;
});
