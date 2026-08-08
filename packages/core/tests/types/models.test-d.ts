import { describe, expectTypeOf, it } from "vitest";
import { event, reaction } from "../../lib/index";
import { collection, f, fn, inverse, refs, staticModel, trait } from "../../lib/models";
import type { Dto, Impl, InstanceOf } from "../../lib/models";

// Type-level scenarios from docs/design/dynamic-models.md. The mutual-cycle
// cases are the §5.4 promise: zero annotations, zero names, zero collectors.

describe("§3.1 typed declaration and instance surface", () => {
  const Todo = staticModel({
    data: (p: import("../../lib/models").Props<{ name: string; done?: boolean }>) => ({
      title: f.string(p.name),
      done: f.boolean(p.done.or(false)),
      draft: f.string(""),
    }),
    setup(self) {
      expectTypeOf(self.title.value).toEqualTypeOf<string>();
      expectTypeOf(self.done.value).toEqualTypeOf<boolean>();
      expectTypeOf(self.id).toEqualTypeOf<string>();

      const toggled = event<void>();

      reaction({
        on: toggled,
        run: () => {
          self.done.value = !self.done.value;
        },
      });

      return { toggled };
    },
  });

  it("instance fields are typed stores; members are typed callables", () => {
    const todos = collection(Todo);
    const t = todos.add({ name: "x" });

    expectTypeOf(t.title.value).toEqualTypeOf<string>();
    expectTypeOf(t.done.value).toEqualTypeOf<boolean>();
    expectTypeOf(t.toggled).toEqualTypeOf<Promise<void>>;
    expectTypeOf(t.id).toEqualTypeOf<string>();
    expectTypeOf(t.alive).toEqualTypeOf<boolean>();

    // @ts-expect-error a string store does not take numbers
    t.title.value = 5;
  });

  it("Dto derives wire keys and optionality from bindings (§9.1)", () => {
    type TodoDto = Dto<typeof Todo>;

    expectTypeOf<TodoDto["name"]>().toEqualTypeOf<string>();
    expectTypeOf<TodoDto["done"]>().toEqualTypeOf<boolean | undefined>();
    expectTypeOf<TodoDto["id"]>().toEqualTypeOf<string | undefined>();

    // local (unbound in function form) is off the wire
    const draftIsOffTheWire: "draft" extends keyof TodoDto ? true : false = false;

    void draftIsOffTheWire;
  });

  it("add() input is typed by the Dto; partial merge needs an id", () => {
    const todos = collection(Todo);

    todos.add({ name: "ok" });
    todos.add({ id: "1", done: true }); // partial merge form

    // @ts-expect-error `name` must be a string
    todos.add({ name: 42 });
  });
});

describe("§8 typed descriptors and queries", () => {
  const Todo = staticModel({
    data: {
      title: f.string(),
      done: f.boolean(false).indexed(),
      priority: f.number(0).indexed("ord"),
    },
  });

  it("descriptor operators are typed by the field", () => {
    Todo.done.eq(true);
    Todo.priority.between(1, 5);
    Todo.title.startsWith("a");

    // @ts-expect-error done is boolean
    Todo.done.eq("yes");
    // @ts-expect-error priority is a number
    Todo.priority.gte("high");
  });

  it("query results are typed instances; select projects the field type", () => {
    const todos = collection(Todo);
    const active = todos.where(Todo.done.eq(false)).sort(Todo.priority.desc).take(5);

    expectTypeOf(active.items[0]!.title.value).toEqualTypeOf<string>();
    expectTypeOf(active.count).toEqualTypeOf<number>();
    expectTypeOf(todos.select(Todo.title)).toEqualTypeOf<string[]>();
    expectTypeOf(todos.first).toEqualTypeOf<InstanceOf<typeof Todo> | null>();
  });
});

describe("§5.4 mutual thunks with zero annotations — the flagship", () => {
  // Both constants reference each other through thunks; nothing is annotated.
  const Post = staticModel({
    data: { title: f.string(), author: refs.one(() => User) },
  });
  const User = staticModel({
    data: { login: f.string(), posts: inverse(() => Post.author) },
  });

  it("navigation is typed across the cycle", () => {
    const posts = collection(Post);
    const p = posts.add({ title: "t" });

    // author.value derefs the thunk LAZILY to the User instance type
    const author = p.author.value;

    expectTypeOf(author).not.toEqualTypeOf<never>();

    if (author !== null) {
      expectTypeOf(author.login.value).toEqualTypeOf<string>();
    }
  });

  it("self-reference types the tree", () => {
    const Arrow = staticModel({
      data: { label: f.string(""), next: refs.one(() => Arrow) },
    });

    const arrows = collection(Arrow);
    const a = arrows.add({});
    const next = a.next.value;

    if (next !== null) {
      expectTypeOf(next.label.value).toEqualTypeOf<string>();
    }
  });
});

describe("§4.4 Impl<> as the generic-code boundary", () => {
  const Selectable = trait({
    requires: {
      selected: f.boolean(),
      canSelect: fn<() => boolean>(),
    },
    setup(self) {
      const toggle = event<void>();

      reaction({
        on: toggle,
        run: () => {
          if (!self.canSelect()) return;
          self.selected.value = !self.selected.value;
        },
      });

      return { toggle };
    },
  });

  const Todo = staticModel({
    with: [Selectable],
    data: { title: f.string(), selected: f.boolean(false) },
    setup() {
      return { canSelect: () => true };
    },
  });

  function selectAll<M extends Impl<typeof Selectable>>(items: readonly M[]): void {
    for (const m of items) {
      m.toggle();
      m.selected.value;
      m.canSelect();
    }
  }

  it("an implementing model's instances satisfy the constraint", () => {
    const todos = collection(Todo);
    const t = todos.add({ title: "x" });

    selectAll([t]);

    expectTypeOf(t.toggle).toBeFunction();
    expectTypeOf(t.selected.value).toEqualTypeOf<boolean>();
  });

  it("a non-implementing instance is rejected", () => {
    const Bare = staticModel({ data: { title: f.string() } });
    const bares = collection(Bare);
    const b = bares.add({ title: "y" });

    // @ts-expect-error Bare does not implement Selectable
    selectAll([b]);
  });
});

describe("§4.1 trait self typing", () => {
  it("trait setup sees required fields and behaviors, typed", () => {
    trait({
      requires: {
        count: f.number(),
        step: fn<() => number>(),
      },
      setup(self) {
        expectTypeOf(self.count.value).toEqualTypeOf<number>();
        expectTypeOf(self.step()).toEqualTypeOf<number>();

        return {};
      },
    });
  });
});
