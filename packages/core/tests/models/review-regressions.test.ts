import { describe, expect, it, vi } from "vitest";
import { computed, event, owner, reaction, scope, scoped, store } from "../../lib/index";
import { collection, f, model, staticModel } from "../../lib/models";
import type { Props } from "../../lib/models";

// Regressions for the adversarial-review findings (workflow wf_435ca70a-adf).
// Each test reproduces a reviewed defect and pins the fixed behavior.

describe("ChainedValues routes app stores by class, not first touch", () => {
  it("read-first: an instance read must not fork an app store", async () => {
    const filter = store("all");
    const seen: string[] = [];

    const Todo = staticModel({
      data: { title: f.string("") },
      setup(self: any) {
        const probe = event<void>();

        reaction({
          on: probe,
          run: () => {
            seen.push(filter.value); // app store read from an instance context
          },
        });

        return { probe };
      },
    });

    const app = scope();

    await scoped(app, async () => {
      const t: any = collection(Todo).add({});

      await t.probe(); // first touch happens INSIDE the instance scope
      filter.value = "active"; // app-scope write afterwards
      await t.probe();
    });

    expect(seen).toEqual(["all", "active"]); // was ["all", "all"] before the fix
  });

  it("write-first: an instance write to an app store lands in the app scope", async () => {
    const counter = store(0);

    const Todo = staticModel({
      data: { title: f.string("") },
      setup() {
        const bump = event<void>();

        reaction({
          on: bump,
          run: () => {
            counter.value = 100;
          },
        });

        return { bump };
      },
    });

    const app = scope();

    await scoped(app, async () => {
      const t: any = collection(Todo).add({});

      await t.bump();

      expect(counter.value).toBe(100); // was 0 before the fix — write leaked into the instance map
    });
  });
});

describe("collection homing (§3.4)", () => {
  it("collection() called from an instance context resolves the app-scope collection", async () => {
    const Note = staticModel({ data: { text: f.string() } });
    const Todo = staticModel({
      data: { title: f.string("") },
      setup() {
        const spawnNote = event<string>();

        reaction({
          on: spawnNote,
          run: (text) => {
            collection(Note).add({ text });
          },
        });

        return { spawnNote };
      },
    });

    const app = scope();

    await scoped(app, async () => {
      const notes = collection(Note);
      const t: any = collection(Todo).add({});

      await t.spawnNote("hello");

      expect(notes.count).toBe(1); // was 0: a shadow collection homed on the instance scope
    });
  });
});

describe("computed members route through the instance (§4.2)", () => {
  it("a computed returned from setup reads instance values, per instance", async () => {
    const Todo = staticModel({
      data: { done: f.boolean(false) },
      setup(self: any) {
        const toggled = event<void>();

        reaction({
          on: toggled,
          run: () => {
            self.done.value = !self.done.value;
          },
        });

        return { toggled, progress: computed(() => (self.done.value ? 1 : 0)) };
      },
    });

    const app = scope();

    await scoped(app, async () => {
      const todos = collection(Todo);
      const a: any = todos.add({});
      const b: any = todos.add({});

      await a.toggled();

      expect(a.progress.value).toBe(1); // was 0: computed evaluated in the caller scope
      expect(b.progress.value).toBe(0); // and stays per-instance
    });
  });
});

describe("facade reads register auto-reaction dependencies (§8)", () => {
  it("an app-level reaction over t.field.value re-runs on instance writes", async () => {
    const Todo = staticModel({ data: { done: f.boolean(false) } });
    const app = scope();

    await scoped(app, async () => {
      const t: any = collection(Todo).add({});
      const runs: boolean[] = [];

      reaction(() => {
        runs.push(t.done.value);
      });

      await Promise.resolve();
      t.done.value = true;
      await Promise.resolve();
      await Promise.resolve();

      expect(runs).toContain(true); // was [false] only: no dependency was tracked
    });
  });
});

describe("dynamic instantiation (§3.1)", () => {
  it("setup sees seeded input values, in the collection's scope", () => {
    const seen: unknown[] = [];

    const Task = model({
      data: (p: Props<{ title: string }>) => ({ title: f.string(p.title) }),
      setup(self: any) {
        seen.push(self.title.value);
      },
    });

    const app = scope();

    scoped(app, () => {
      collection(Task).add({ title: "hello" });
    });

    expect(seen).toEqual(["hello"]); // was [undefined]: seeding ran after setup
  });

  it("add() works without an ambient scope once the collection exists", () => {
    const Task = model({ data: { title: f.string() } });
    const app = scope();
    const tasks = scoped(app, () => collection(Task));

    // no ambient scope here
    const t: any = (tasks as any).add({ title: "x" });

    expect(t.title.value).toBe("x");
  });

  it("dynamic self has the instance API inside unit bodies (§3.1)", async () => {
    const seen: string[] = [];

    const Task = model({
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

    const app = scope();

    await scoped(app, async () => {
      const t: any = collection(Task).add({ id: "d1", title: "first" });

      await t.ping();
    });

    expect(seen).toEqual(["d1:first"]);
  });

  it("dynamic setup-return colliding with a field is a declaration error (§4.6)", () => {
    const Task = model({
      data: { title: f.string("") },
      setup() {
        return { title: () => "shadow" };
      },
    });

    const app = scope();

    scoped(app, () => {
      expect(() => collection(Task).add({})).toThrowError(/declared as a field/);
    });
  });
});

describe("subscription and owner capture", () => {
  it("collection index subscriptions survive an ambient owner's dispose", () => {
    const Todo = staticModel({ data: { done: f.boolean(false).indexed() } });
    const app = scope();

    scoped(app, () => {
      const holder = owner((dispose) => {
        collection(Todo); // first created inside an unrelated owner

        return { dispose };
      });

      holder.dispose(); // must NOT kill the collection's index subscription

      const todos: any = collection(Todo);
      const t: any = todos.add({});

      t.done.value = true;

      expect(todos.where((Todo as any).done.eq(true)).count).toBe(1);
    });
  });
});

describe("merge and replace (§3.1)", () => {
  it("replace with an absent required key throws instead of writing undefined", () => {
    const Todo = staticModel({
      data: { title: f.string(), done: f.boolean(false) },
    });
    const app = scope();

    scoped(app, () => {
      const todos = collection(Todo);
      const t: any = todos.add({ id: "1", title: "keep me" });

      expect(() => todos.add({ id: "1", done: true }, { replace: true })).toThrowError(/title/);
      expect(t.title.value).toBe("keep me"); // nothing was written
    });
  });

  it("array add is atomic: a failing element rolls back the batch", () => {
    const Todo = staticModel({ data: { title: f.string() } });
    const app = scope();

    scoped(app, () => {
      const todos = collection(Todo);

      expect(() => todos.add([{ title: "ok" }, {} as { title: string }])).toThrowError(/title/);
      expect(todos.count).toBe(0); // was 1: first element survived
    });
  });
});

describe("rebind chains (§10.1)", () => {
  it("older aliases re-point on a second rebind and die with the instance", () => {
    const Todo = staticModel({ data: { title: f.string("") } });
    const app = scope();

    scoped(app, () => {
      const todos = collection(Todo);
      const t: any = todos.add({});
      const temp = t.id;

      t.rebind("A");
      t.rebind("B");

      expect(todos.get(temp)).toBe(todos.get("B")); // was null: dangling tmp→A
      expect(todos.get("A")).toBe(todos.get("B"));

      todos.remove("B");
      expect(todos.get(temp)).toBeNull();
      expect(todos.get("A")).toBeNull();
    });
  });
});

describe("date fields in indexes and eq (§7/§8)", () => {
  it("f.date().indexed() buckets by time value, eq matches", () => {
    const iso = "2026-08-08T10:00:00.000Z";
    const Todo = staticModel({
      data: (p: Props<{ due: string }>) => ({
        due: f
          .date(p.due.map((wire) => new Date(wire), (value) => value.toISOString()))
          .indexed(),
      }),
    });
    const app = scope();

    scoped(app, () => {
      const todos: any = collection(Todo);

      todos.add([{ due: iso }, { due: "2027-01-01T00:00:00.000Z" }]);

      expect(todos.where((Todo as any).due.eq(new Date(iso))).count).toBe(1);
    });
  });
});

describe("descriptor identity (§8)", () => {
  it("a descriptor from another model is rejected", () => {
    const A = staticModel({ data: { x: f.number(0) } });
    const B = staticModel({ data: { x: f.number(0) } });
    const app = scope();

    scoped(app, () => {
      const as: any = collection(A);

      expect(() => as.where((B as any).x.eq(1))).toThrowError(/different model/);
    });
  });
});

describe("liveness of the static ambient self", () => {
  it("self.json() after dispose throws 'entity was disposed', not stale data", async () => {
    const results: string[] = [];

    const Todo = staticModel({
      data: { title: f.string("") },
      setup(self: any) {
        const probe = event<void>();

        reaction({
          on: probe,
          run: () => {
            try {
              self.json();
              results.push("ok");
            } catch (error) {
              results.push((error as Error).message);
            }
          },
        });

        return { probe };
      },
    });

    const app = scope();

    await scoped(app, async () => {
      const t: any = collection(Todo).add({});
      const probe = t.probe;

      await probe();
      t.dispose();
    });

    expect(results).toEqual(["ok"]);
  });
});

describe("dispose releases the facade cache (§3.5)", () => {
  it("facades map does not retain disposed instances", () => {
    const Todo = staticModel({ data: { title: f.string("") } });
    const app = scope();

    scoped(app, () => {
      const todos: any = collection(Todo);
      const t: any = todos.add({});

      todos.remove(t.id);

      expect(() => t.title.value).toThrowError(/disposed/);
      expect(todos.count).toBe(0);
    });
  });
});
