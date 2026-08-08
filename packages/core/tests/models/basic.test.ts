import { describe, expect, it, vi } from "vitest";
import { event, reaction, scope, scoped } from "../../lib/index";
import { collection, f, fn, model, staticModel, trait } from "../../lib/models";
import type { Props } from "../../lib/models";

// Scenarios follow docs/design/dynamic-models.md; section references in names.

function appScope() {
  return scope();
}

function declareTodo(kind: typeof model | typeof staticModel) {
  return kind({
    data: (p: Props<{ name: string; done?: boolean }>) => ({
      title: f.string(p.name),
      done: f.boolean(p.done.or(false)),
    }),
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
}

describe.each([
  ["staticModel", staticModel],
  ["model", model],
] as const)("§3.1 declaration and creation (%s)", (_label, kind) => {
  it("adds by props shape, exposes store surface, reacts through units", async () => {
    const Todo = declareTodo(kind);
    const app = appScope();

    await scoped(app, async () => {
      const todos = collection(Todo);
      const t: any = todos.add({ name: "Buy milk" });

      expect(t.title.value).toBe("Buy milk");
      expect(t.done.value).toBe(false);

      await t.toggled();

      expect(t.done.value).toBe(true);

      todos.remove(t.id);
      expect(t.alive).toBe(false);
    });
  });

  it("isolates instances: a reaction touches only its own instance", async () => {
    const Todo = declareTodo(kind);
    const app = appScope();

    await scoped(app, async () => {
      const todos = collection(Todo);
      const a: any = todos.add({ name: "a" });
      const b: any = todos.add({ name: "b" });

      await a.toggled();

      expect(a.done.value).toBe(true);
      expect(b.done.value).toBe(false);
    });
  });

  it("isolates scopes: two scopes — two independent collections", () => {
    const Todo = declareTodo(kind);
    const first = appScope();
    const second = appScope();

    const inFirst = scoped(first, () => collection(Todo).add({ name: "x" })) as any;

    scoped(second, () => {
      expect(collection(Todo).count).toBe(0);
    });

    scoped(first, () => {
      expect(collection(Todo).count).toBe(1);
      expect(collection(Todo).get(inFirst.id)).not.toBeNull();
    });
  });
});

describe("§3.1 add is an upsert", () => {
  it("merges present keys by id, leaves absent keys alone", () => {
    const Todo = declareTodo(staticModel);
    const app = appScope();

    scoped(app, () => {
      const todos = collection(Todo);
      const t: any = todos.add({ id: "42", name: "initial", done: true });

      todos.add({ id: "42", name: "renamed" });

      expect(todos.count).toBe(1);
      expect(t.title.value).toBe("renamed");
      expect(t.done.value).toBe(true);
    });
  });

  it("accepts arrays and returns instances in input order", () => {
    const Todo = declareTodo(staticModel);
    const app = appScope();

    scoped(app, () => {
      const todos = collection(Todo);
      const [a, b] = todos.add([
        { name: "first" },
        { name: "second" },
      ]) as any[];

      expect(a.title.value).toBe("first");
      expect(b.title.value).toBe("second");
      expect(todos.count).toBe(2);
    });
  });

  it("names missing required keys on create", () => {
    const Todo = declareTodo(staticModel);
    const app = appScope();

    scoped(app, () => {
      expect(() => collection(Todo).add({})).toThrowError(/name/);
    });
  });
});

describe("§4 traits", () => {
  const Selectable = trait({
    requires: {
      selected: f.boolean(),
      canSelect: fn<() => boolean>(),
    },
    setup(self: any) {
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

  it("members flow into self and the instance without qualification (§4.2)", async () => {
    const Todo = staticModel({
      with: [Selectable],
      data: {
        title: f.string(),
        selected: f.boolean(false),
        archived: f.boolean(false),
      },
      setup(self: any) {
        return { canSelect: () => !self.archived.value };
      },
    });

    const app = appScope();

    await scoped(app, async () => {
      const todos = collection(Todo);
      const t: any = todos.add({ title: "x" });

      await t.toggle();
      expect(t.selected.value).toBe(true);

      t.archived.value = true;
      await t.toggle();
      expect(t.selected.value).toBe(true); // canSelect() blocked the toggle
    });
  });

  it("law of names: many may require, exactly one declares (§4.6)", () => {
    const Hoverable = trait({ requires: { selected: f.boolean() } });

    expect(() =>
      staticModel({
        with: [Selectable, Hoverable],
        data: { selected: f.boolean(false) },
        setup: (self: any) => ({ canSelect: () => true }),
      }),
    ).not.toThrow();
  });

  it("declaration collision is a declaration-time error (§4.6)", () => {
    const A = trait({ data: { shared: f.number(0) } });
    const B = trait({ data: { shared: f.number(1) } });

    expect(() => staticModel({ with: [A, B] })).toThrowError(/collision/);
  });

  it("unimplemented behavior requirement is a declaration-time error (§4.6)", () => {
    expect(() =>
      staticModel({
        with: [Selectable],
        data: { selected: f.boolean(false) },
      }),
    ).toThrowError(/canSelect/);
  });

  it("undeclared required field is a declaration-time error (§4.6)", () => {
    expect(() =>
      staticModel({
        with: [Selectable],
        setup: () => ({ canSelect: () => true }),
      }),
    ).toThrowError(/selected/);
  });

  it("reserved API names are rejected (§4.6)", () => {
    expect(() => staticModel({ data: { json: f.string("") } })).toThrowError(/instance/);
  });
});

describe("§4.5 parameterized traits on TypeBox arguments", () => {
  it("applies positionally and keeps working members", async () => {
    const Keyed = trait({
      requires: { code: f.arg(0) },
      setup(self: any) {
        return { sameKeyAs: (other: any) => self.code.value === other.code.value };
      },
    });

    const Todo = staticModel({
      with: [Keyed(f.string())],
      data: { code: f.string("") },
    });

    const app = appScope();

    scoped(app, () => {
      const todos = collection(Todo);
      const a: any = todos.add({ code: "k1" });
      const b: any = todos.add({ code: "k1" });
      const c: any = todos.add({ code: "other" });

      expect(a.sameKeyAs(b)).toBe(true);
      expect(a.sameKeyAs(c)).toBe(false);
    });
  });
});

describe("§9.1 codec is the props binding", () => {
  const iso = "2026-08-08T00:00:00.000Z";

  const Timestamped = trait({
    data: (p: Props<{ created_at: string }>) => ({
      createdAt: f.date(p.created_at.map((wire) => new Date(wire), (value) => value.toISOString())),
    }),
  });

  it("binds by key with transforms both ways, locals stay off the wire", () => {
    const Todo = staticModel({
      with: [Timestamped],
      data: (p: Props<{ name: string }>) => ({
        title: f.string(p.name),
        draft: f.string("").local(),
      }),
    });

    const app = appScope();

    scoped(app, () => {
      const todos = collection(Todo);
      const t: any = todos.add({ id: "1", name: "hello", created_at: iso });

      expect(t.createdAt.value).toBeInstanceOf(Date);
      expect(t.draft.value).toBe("");

      const json = t.json();

      expect(json).toEqual({ id: "1", name: "hello", created_at: iso });
      expect(JSON.parse(JSON.stringify(t))).toEqual(json); // toJSON protocol on top of json()
    });
  });

  it("omits an in-only bound field from json() with a dev diagnostic (§9.1)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const Todo = staticModel({
      data: (p: Props<{ raw: string; plain?: string }>) => ({
        parsed: f.string(p.raw.map((wire) => wire.trim())),
        plain: f.string(p.plain.or("x")),
        local: f.string("draft"), // несвязанное поле в функциональной форме — локально (§3.1)
      }),
    });

    const app = appScope();

    scoped(app, () => {
      const t: any = collection(Todo).add({ id: "1", raw: "  y  " });

      expect(t.parsed.value).toBe("y");
      expect(t.local.value).toBe("draft");
      expect(t.json()).toEqual({ id: "1", plain: "x" }); // ни parsed (in-only), ни local
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("in-transform only"));
    });

    warn.mockRestore();
  });

  it("temporary autogenerated ids never serialize (§10.1)", () => {
    const Todo = declareTodo(staticModel);
    const app = appScope();

    scoped(app, () => {
      const t: any = collection(Todo).add({ name: "n" });

      expect(t.json()).not.toHaveProperty("id");

      t.rebind("server-1");
      expect(t.json()).toHaveProperty("id", "server-1");
    });
  });
});

describe("§10.1 rebind and forwarding", () => {
  it("rebinds id, forwards the old one, add() drops a reclaimed alias", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const Todo = declareTodo(staticModel);
    const app = appScope();

    scoped(app, () => {
      const todos = collection(Todo);
      const t: any = todos.add({ name: "n" });
      const temp = t.id;

      t.rebind("real-1");

      expect(t.id).toBe("real-1");
      expect(todos.get(temp)).toBe(todos.get("real-1")); // forwarding fallback
      expect(t.key).toBeTypeOf("string"); // stable UI key survives rebind

      const fresh: any = todos.add({ id: temp, name: "reclaim" });

      expect(warn).toHaveBeenCalledWith(expect.stringContaining("forwarding"));
      expect(todos.get(temp)).toBe(fresh); // direct match wins from now on
    });

    warn.mockRestore();
  });

  it("forwarding dies with the instance", () => {
    const Todo = declareTodo(staticModel);
    const app = appScope();

    scoped(app, () => {
      const todos = collection(Todo);
      const t: any = todos.add({ name: "n" });
      const temp = t.id;

      t.rebind("real-2");
      todos.remove("real-2");

      expect(todos.get(temp)).toBeNull();
    });
  });
});

describe("§8 queries", () => {
  function seed(kind: typeof model | typeof staticModel) {
    const Todo = kind({
      data: {
        title: f.string(),
        done: f.boolean(false).indexed(),
        priority: f.number(0),
      },
    });

    const app = appScope();
    const seeded = scoped(app, () => {
      const todos = collection(Todo);

      todos.add([
        { title: "a", done: false, priority: 3 },
        { title: "b", done: true, priority: 1 },
        { title: "c", done: false, priority: 7 },
      ]);

      return todos;
    });

    return { Todo: Todo as any, todos: seeded as any };
  }

  it.each([
    ["staticModel", staticModel],
    ["model", model],
  ] as const)("descriptor predicates, sort, take (%s)", (_label, kind) => {
    const { Todo, todos } = seed(kind);

    const active = todos.where(Todo.done.eq(false)).sort(Todo.priority.desc).take(1);

    expect(active.ids.length).toBe(1);
    expect(active.first.title.value).toBe("c");
    expect(todos.where(Todo.priority.gte(3)).count).toBe(2);
    expect(todos.where(Todo.title.startsWith("a")).count).toBe(1);
  });

  it("indexed eq stays correct after writes through stores and reactions", () => {
    const { Todo, todos } = seed(staticModel);
    const [a] = todos.items;

    a.done.value = true;

    expect(todos.where(Todo.done.eq(true)).count).toBe(2);
    expect(todos.where(Todo.done.eq(false)).count).toBe(1);
  });

  it("plain predicate where() works as a residual scan", () => {
    const { todos } = seed(staticModel);

    expect(todos.where((t: any) => t.priority.value > 2).count).toBe(2);
  });

  it("bulk set routes through instances and indexes", () => {
    const { Todo, todos } = seed(staticModel);

    todos.where(Todo.done.eq(false)).set(Todo.done, true);

    expect(todos.where(Todo.done.eq(true)).count).toBe(3);
  });

  it("collection is an unfiltered query (§6)", () => {
    const { todos } = seed(staticModel);

    expect(todos.count).toBe(3);
    expect([...todos].length).toBe(3);
    expect(todos.select({ field: "title" })).toEqual(["a", "b", "c"]);
  });
});

describe("§3.1 instance API inside unit bodies", () => {
  it("self.json()/self.id resolve the ambient instance in a reaction", async () => {
    const seen: string[] = [];

    const Todo = staticModel({
      data: { title: f.string() },
      setup(self: any) {
        const ping = event<void>();

        reaction({
          on: ping,
          run: () => {
            seen.push(`${self.id}:${self.json().title}`);
          },
        });

        return { ping };
      },
    });

    const app = appScope();

    await scoped(app, async () => {
      const todos = collection(Todo);
      const a: any = todos.add({ id: "a", title: "first" });
      const b: any = todos.add({ id: "b", title: "second" });

      await a.ping();
      await b.ping();
    });

    expect(seen).toEqual(["a:first", "b:second"]);
  });

  it("instance API outside a unit body is an error in static setup (§3.1)", () => {
    expect(() =>
      staticModel({
        data: { title: f.string("") },
        setup(self: any) {
          self.json();

          return {};
        },
      }),
    ).toThrowError(/instance context/);
  });
});
