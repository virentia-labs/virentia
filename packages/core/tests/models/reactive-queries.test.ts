import { describe, expect, it } from "vitest";
import { computed, event, reaction, scope, scoped } from "../../lib/index";
import { f, model, staticModel } from "../../lib/models";
import { collection, type Query } from "../../lib/models/collection";
import { withTransaction } from "../../lib/internal";

// §7.3 ord indexes and §8 reactive query terminals with plan interning.

function app<T>(fn: () => T): T {
  return scoped(scope(), fn) as T;
}

function declareTodos(kind: typeof model | typeof staticModel) {
  const Todo: any = kind({
    data: {
      title: f.string(),
      done: f.boolean(false).indexed(),
      priority: f.number(0).indexed("ord"),
    },
  });

  return Todo;
}

describe("lazy collection epoch exposure", () => {
  it("exposes the current epoch and then publishes every subsequent change", () => {
    const Row = staticModel({ data: { count: f.number(0) } });
    const current = scope();
    const rows = collection(Row, current);
    scoped(current, () => {
      Row.create({ id: "one" });
      Row.create({ id: "two" });
    });
    expect(rows.count).toBe(2);
    const version = (rows as unknown as Query)["~versions"]!()[0];
    expect(scoped(current, () => version.value)).toBe(2);
    const seen: number[] = [];
    const off = version.subscribe((value) => {
      seen.push(value);
    });
    scoped(current, () => {
      Row.create({ id: "three" });
    });
    rows.get("three")!.count.value = 5;
    rows.remove("three");
    expect(seen).toEqual([3, 4, 5]);
    off();
  });

  it("keeps transaction staging and late auto-query subscriptions intact", () => {
    const Row = staticModel({ data: { count: f.number(0) } });
    const current = scope();
    const rows = collection(Row, current);
    const seen: number[] = [];
    let observer!: ReturnType<typeof reaction>;
    scoped(current, () =>
      withTransaction(() => {
        Row.create({ id: "one" });
        observer = reaction({
          scope: current,
          run: () => {
            seen.push(rows.count);
          },
        });
        Row.create({ id: "two" });
        expect(rows.count).toBe(2);
      }),
    );
    expect(seen.at(-1)).toBe(2);
    scoped(current, () => {
      Row.create({ id: "three" });
    });
    expect(seen.at(-1)).toBe(3);
    observer.stop();
  });
});

describe("§7.3 ord indexes", () => {
  it("range predicates use the sorted view and stay correct after writes", () => {
    const Todo = declareTodos(staticModel);

    app(() => {
      const todos: any = collection(Todo);

      todos.add([
        { title: "a", priority: 5 },
        { title: "b", priority: 1 },
        { title: "c", priority: 9 },
        { title: "d", priority: 3 },
      ]);

      expect(todos.where(Todo.priority.gte(4)).select(Todo.title)).toEqual(["a", "c"]);
      expect(todos.where(Todo.priority.lt(4)).select(Todo.title)).toEqual(["b", "d"]);
      expect(todos.where(Todo.priority.between(2, 6)).select(Todo.title)).toEqual(["d", "a"]);

      const [a] = todos.items;

      a.priority.value = 0; // dirty → lazy rebuild on next query

      expect(todos.where(Todo.priority.lt(2)).select(Todo.title)).toEqual(["a", "b"]);
    });
  });

  it("range candidates come back in field order; sort by the same field is stable", () => {
    const Todo = declareTodos(staticModel);

    app(() => {
      const todos: any = collection(Todo);

      todos.add([
        { title: "x", priority: 7 },
        { title: "y", priority: 2 },
        { title: "z", priority: 4 },
      ]);

      const asc = todos.where(Todo.priority.gt(0)).sort(Todo.priority.asc);
      const desc = todos.where(Todo.priority.gt(0)).sort(Todo.priority.desc);

      expect(asc.select(Todo.title)).toEqual(["y", "z", "x"]);
      expect(desc.select(Todo.title)).toEqual(["x", "z", "y"]);
    });
  });

  it("dispose and rebind keep the ord view consistent", () => {
    const Todo = declareTodos(staticModel);

    app(() => {
      const todos: any = collection(Todo);
      const [a, b] = todos.add([
        { title: "a", priority: 1 },
        { title: "b", priority: 2 },
      ]);

      a.rebind("A-1");
      expect(todos.where(Todo.priority.lte(1)).ids).toEqual(["A-1"]);

      todos.remove(b.id);
      expect(todos.where(Todo.priority.gte(0)).ids).toEqual(["A-1"]);
    });
  });
});

describe.each([
  ["staticModel", staticModel],
  ["model", model],
] as const)("§8 reactive terminals (%s)", (_label, kind) => {
  it("a reaction over query.count re-runs on add, field write, and remove", async () => {
    const Todo = declareTodos(kind);

    await app(async () => {
      const todos: any = collection(Todo);
      const active = todos.where(Todo.done.eq(false));
      const counts: number[] = [];

      reaction(() => {
        counts.push(active.count);
      });

      await Promise.resolve();

      const t = todos.add({ title: "one" });

      await Promise.resolve();
      await Promise.resolve();

      t.done.value = true;

      await Promise.resolve();
      await Promise.resolve();

      expect(counts[0]).toBe(0); // initial run
      expect(counts).toContain(1); // after add
      expect(counts.at(-1)).toBe(0); // after done=true left the filter
    });
  });

  it("a computed over query.ids recomputes per epoch", () => {
    const Todo = declareTodos(kind);

    app(() => {
      const todos: any = collection(Todo);
      const activeIds = computed(() => todos.where(Todo.done.eq(false)).ids.join(","));

      expect(activeIds.value).toBe("");

      const t = todos.add({ id: "t1", title: "one" });

      expect(activeIds.value).toBe("t1");

      t.done.value = true;

      expect(activeIds.value).toBe("");
    });
  });
});

describe("§8 plan interning and stable identity", () => {
  it("a chain rebuilt with the same values returns the SAME items array", () => {
    const Todo = declareTodos(staticModel);

    app(() => {
      const todos: any = collection(Todo);

      todos.add([
        { title: "a", priority: 1 },
        { title: "b", priority: 5 },
      ]);

      const first = todos.where(Todo.priority.gte(2)).items;
      const second = todos.where(Todo.priority.gte(2)).items; // rebuilt chain, same binds

      expect(second).toBe(first);
    });
  });

  it("an epoch bump that does not change the result keeps referential identity", () => {
    const Todo = declareTodos(staticModel);

    app(() => {
      const todos: any = collection(Todo);
      const [a] = todos.add([
        { title: "a", priority: 1 },
        { title: "b", priority: 5 },
      ]);

      const query = todos.where(Todo.priority.gte(2));
      const before = query.items;

      a.title.value = "renamed"; // bumps the epoch, does not affect this result

      expect(query.items).toBe(before);
      expect(query.ids).toBe(query.ids);
    });
  });

  it("different bind values recompute, same shape", () => {
    const Todo = declareTodos(staticModel);

    app(() => {
      const todos: any = collection(Todo);

      todos.add([
        { title: "a", priority: 1 },
        { title: "b", priority: 5 },
      ]);

      expect(todos.where(Todo.priority.gte(2)).select(Todo.title)).toEqual(["b"]);
      expect(todos.where(Todo.priority.gte(0)).select(Todo.title)).toEqual(["a", "b"]);
      expect(todos.where(Todo.priority.gte(2)).select(Todo.title)).toEqual(["b"]);
    });
  });

  it("scan predicates participate in the plan by function identity", () => {
    const Todo = declareTodos(staticModel);

    app(() => {
      const todos: any = collection(Todo);

      todos.add([
        { title: "aa", priority: 1 },
        { title: "b", priority: 5 },
      ]);

      const longTitle = (t: any) => t.title.value.length > 1;
      const q = () => todos.where(longTitle);

      expect(q().select(Todo.title)).toEqual(["aa"]);
      expect(q().items).toBe(q().items); // same fn identity → same plan slot
    });
  });

  it("relation writes bump the epoch too", async () => {
    const User: any = staticModel({ data: { login: f.string() }, name: "user" });
    const Post: any = staticModel({
      data: { title: f.string(""), author: (await import("../../lib/models")).refs.one(User) },
      name: "post",
    });

    app(() => {
      const users: any = collection(User);
      const posts: any = collection(Post);
      const bob = users.add({ login: "bob" });
      const p = posts.add({});
      const authored = computed(() => posts.where((x: any) => x.author.value !== null).count);

      expect(authored.value).toBe(0);

      p.author.value = bob;

      expect(authored.value).toBe(1);
    });
  });
});

describe("§3.4 reactions stay per-instance with reactive queries around", () => {
  it("static units and query reactivity coexist", async () => {
    const Todo: any = staticModel({
      data: { done: f.boolean(false).indexed() },
      setup(self: any) {
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

    await app(async () => {
      const todos: any = collection(Todo);
      const done = todos.where(Todo.done.eq(true));
      const a = todos.add({});
      const b = todos.add({});

      await a.toggled();

      expect(done.ids).toEqual([a.id]);

      await b.toggled();

      expect(done.ids).toEqual([a.id, b.id]);

      await a.toggled();

      expect(done.ids).toEqual([b.id]);
    });
  });
});

describe("query memo after ids are reused", () => {
  it("removes instances recreated under the ids of removed ones", async () => {
    const Row: any = staticModel({ data: { label: f.string("") } });
    const app = scope();
    const data = [{ id: "a", label: "a" }, { id: "b", label: "b" }];
    scoped(app, () => Row.create(data));
    // A read memoizes the query's ids; the same ids come back below, and the
    // second remove() resolves the query without any read in between.
    expect(scoped(app, () => Row.instances.ids)).toEqual(["a", "b"]);
    await scoped(app, () => Row.instances.remove());
    scoped(app, () => Row.create(data));
    await scoped(app, () => Row.instances.remove());
    expect(scoped(app, () => Row.instances.count)).toBe(0);
  });

  it("hands out the recreated instances, keeping the id array", () => {
    const Row: any = staticModel({ data: { label: f.string("") } });
    const app = scope();
    const first = scoped(app, () => Row.create({ id: "a", label: "first" }));
    const ids = scoped(app, () => Row.instances.ids);
    expect(scoped(app, () => Row.instances.items)).toEqual([first]);
    scoped(app, () => first.dispose());
    const second = scoped(app, () => Row.create({ id: "a", label: "second" }));
    expect(scoped(app, () => Row.instances.items[0])).toBe(second);
    expect(scoped(app, () => Row.instances.first.label.value)).toBe("second");
    expect(scoped(app, () => Row.instances.ids)).toBe(ids);
  });
});
