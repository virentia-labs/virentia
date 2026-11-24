import { describe, expect, it } from "vitest";
import { computed, event, reaction, scope, scoped, serialize } from "../../lib";
import * as models from "../../lib/models";
import { children, f, model, refs, staticModel, trait, union } from "../../lib/models";
import { sequenceBindingOf } from "../../lib/sequence";
import { modelInstanceBindingOf } from "../../lib/models/bindings";

for (const define of [model, staticModel]) {
  describe(`${define.name}: direct instance access`, () => {
    function taskModel() {
      return define({
        name: "DirectTask",
        data: {
          title: f.string(),
          done: f.boolean(false).indexed(),
          count: f.number(0).indexed("ord"),
        },
        setup(self) {
          const increment = event<number>();
          reaction({
            on: increment,
            run: (n) => {
              self.count.value += n;
            },
          });
          return { increment };
        },
      });
    }

    it("creates, gets, upserts, rebinds and disposes without a collection helper", async () => {
      const Task = taskModel();
      const app = scope();
      const task = scoped(app, () => {
        expect(Task.get("a")).toBeNull();
        expect(Task.instances.count).toBe(0);
        const task = Task.create({ id: "a", title: "First" });
        expect(Task.get("a")).toBe(task);
        expect(Task.create({ id: "a", title: "Updated" })).toBe(task);
        expect(Task.instances.items).toEqual([task]);
        return task;
      });
      await task.increment(2);
      expect(task.count.value).toBe(2);
      expect(task.title.value).toBe("Updated");
      task.rebind("b");
      scoped(app, () => {
        expect(Task.get("b")).toBe(task);
        expect(Task.get("a")).toBe(task);
      });
      await task.dispose();
      scoped(app, () => {
        expect(Task.get("a")).toBeNull();
        expect(Task.get("b")).toBeNull();
        expect(Task.instances.count).toBe(0);
      });
    });

    it("isolates the registry store and the same ID between simultaneous scopes", async () => {
      const Task = taskModel();
      const first = scope(),
        second = scope();
      const [a, b] = await Promise.all(
        [first, second].map((app, index) =>
          scoped(app, async () => {
            const task = Task.create({ id: "same", title: String(index) });
            await task.increment(index + 1);
            expect(Task.get("same")).toBe(task);
            expect(Task.instances.items).toEqual([task]);
            return task;
          }),
        ),
      );
      expect(a).not.toBe(b);
      expect([a.count.value, b.count.value]).toEqual([1, 2]);
      await a.dispose();
      expect(scoped(first, () => Task.get("same"))).toBeNull();
      expect(scoped(second, () => Task.get("same"))).toBe(b);
      expect(
        [...first.values.values()].some(
          (value) => typeof value === "object" && value !== null && "~collection" in value,
        ),
      ).toBe(true);
    });

    it("requires a scope for access and does not share registry values copied to another scope", () => {
      const Task = taskModel();
      expect(() => Task.get("a")).toThrow(/Scope is required/);
      expect(() => Task.instances).toThrow(/Scope is required/);
      const app = scope();
      const original = scoped(app, () => Task.create({ id: "a", title: "Original" }));
      const snapshot = scope();
      for (const [key, value] of app.values) snapshot.values.set(key, value);
      scoped(snapshot, () => {
        expect(Task.get("a")).toBeNull();
        Task.create({ id: "a", title: "Independent" });
      });
      expect(scoped(app, () => Task.get("a"))).toBe(original);
      expect(original.title.value).toBe("Original");
    });

    it("keeps LINQ filters, indexed sorting, projections and stable result identity", async () => {
      const Task = taskModel();
      const app = scope();
      const { a, b, top } = scoped(app, () => {
        const [a, b] = Task.create([
          { id: "a", title: "A", count: 1 },
          { id: "b", title: "B", count: 3 },
          { id: "c", title: "C", count: 2, done: true },
        ]);
        const top = Task.where(Task.done.eq(false)).sort(Task.count.desc).take(2);
        expect(top.first).toBe(b);
        expect(top.ids).toEqual(["b", "a"]);
        expect(top.select(Task.title)).toEqual(["B", "A"]);
        expect([...top]).toEqual([b, a]);
        expect(Task.instances.where((item) => item.count.value >= 2).count).toBe(2);
        expect(Task.sort(Task.count.asc).take(1).first).toBe(a);
        expect(Task.take(1).first).toBe(a);
        expect(Task.where(Task.done.eq(false)).sort(Task.count.desc).take(2).items).toBe(top.items);
        return { a, b, top };
      });
      const before = top.items;
      b.title.value = "Renamed";
      expect(top.items).toBe(before);
      await a.increment(5);
      expect(top.ids).toEqual(["a", "b"]);
      top.set(Task.done, true);
      expect(top.items).toEqual([]);
      await scoped(app, () => Task.where(Task.done.eq(true)).remove());
      expect(scoped(app, () => Task.instances.count)).toBe(0);
    });

    it("reactively follows get, membership and field-dependent selections", async () => {
      const Task = taskModel();
      const app = scope();
      const selected = computed(() => Task.get("a"));
      const active = computed(() => Task.where(Task.done.eq(false)).count);
      const seen: number[] = [];
      const watch = reaction({
        scope: app,
        run: () => {
          seen.push(active.value);
        },
      });
      scoped(app, () => expect(selected.value).toBeNull());
      const task = scoped(app, () => Task.create({ id: "a", title: "A" }));
      scoped(app, () => expect(selected.value).toBe(task));
      task.done.value = true;
      await task.dispose();
      scoped(app, () => expect(selected.value).toBeNull());
      expect(seen).toEqual([0, 1, 0]);
      watch.stop();
    });

    it("keeps the operation stream for filtered, sorted and limited queries", () => {
      const Task = taskModel();
      const app = scope();
      const query = scoped(app, () => Task.where(Task.done.eq(false)).sort(Task.count.asc).take(2));
      const feed = sequenceBindingOf(query)!;
      const operations: string[] = [];
      const stop = feed.subscribe((edits) => {
        operations.push(...edits.map((edit) => edit.type));
      });
      const task = scoped(app, () => Task.create({ id: "a", title: "A" }));
      const second = scoped(app, () => Task.create({ id: "b", title: "B", count: 1 }));
      task.count.value = 2;
      second.done.value = true;
      expect(feed.snapshot()).toEqual([task]);
      expect(operations).toEqual(["insert", "insert", "move", "remove"]);
      stop();
    });

    it("preserves parent ownership and refs without exposing a collection", async () => {
      const Task = taskModel();
      const Board = define({
        data: { tasks: children.many(Task), selected: refs.one(Task, { policy: "orphan" }) },
      });
      const app = scope();
      const board = scoped(app, () => Board.create({ tasks: [{ id: "child", title: "Owned" }] }));
      const child = board.tasks.items[0];
      board.selected.value = child;
      expect(scoped(app, () => Task.get("child"))).toBe(child);
      expect(() => scoped(app, () => Task.create({ title: "Orphan" }))).toThrow(
        /owned as children/,
      );
      await board.dispose();
      expect(child.alive).toBe(false);
      expect(scoped(app, () => Task.get("child"))).toBeNull();
    });

    it("does not serialize runtime registries and restores model state normally", () => {
      const Task = taskModel();
      const server = scope();
      scoped(server, () => Task.create({ id: "a", title: "SSR", count: 5 }));
      const snapshot = serialize(server);
      expect(() => JSON.stringify(snapshot)).not.toThrow();
      expect(JSON.stringify(snapshot)).not.toContain("~collection");
      const client = scope({ snapshot });
      const restored = scoped(client, () => Task.create({ id: "a", title: "Client", count: 0 }));
      expect(restored.title.value).toBe("SSR");
      expect(restored.count.value).toBe(5);
      expect(scoped(client, () => Task.get("a"))).toBe(restored);
    });

    it("awaits asynchronous disposal of every match in a LINQ query", async () => {
      const Task = taskModel();
      const app = scope();
      const tasks = scoped(app, () => Task.create([{ title: "A" }, { title: "B" }]));
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      for (const task of tasks) modelInstanceBindingOf(task)!.beforeDispose(() => gate);
      const completion = scoped(app, () => Task.where(Task.done.eq(false)).remove());
      expect(tasks.every((task) => task.alive)).toBe(true);
      release();
      await completion;
      expect(tasks.every((task) => !task.alive)).toBe(true);
    });
  });
}

describe("model registry public contract", () => {
  it("does not export collection and reserves only the new access names", () => {
    expect(models).not.toHaveProperty("collection");
    for (const key of ["get", "instances", "where", "sort", "take"]) {
      expect(() => staticModel({ data: { [key]: f.string("") } })).toThrow();
    }
    const Model = staticModel({ data: { count: f.number(0), first: f.string("") } });
    expect(Object.keys(Model)).not.toContain("instances");
    expect(() => ({ ...Model })).not.toThrow();
  });

  it("keeps union routing, get, common-field LINQ and exhaustive match", () => {
    const Timestamped = trait({ data: { timestamp: f.number(0).indexed("ord") } });
    const Post = model({ with: [Timestamped], data: { title: f.string() } });
    const Ad = staticModel({ with: [Timestamped], data: { budget: f.number() } });
    const Feed = union(Post, Ad).by((input) => ("title" in input ? Post : Ad));
    const app = scope();
    scoped(app, () => {
      const [post, ad] = Feed.create([
        { id: "post", title: "Hello", timestamp: 1 },
        { id: "ad", budget: 100, timestamp: 2 },
      ]);
      expect(Feed.get("post")).toBe(Post.get("post"));
      expect(Feed.get("ad")).toBe(Ad.get("ad"));
      expect(Feed.where(Feed.timestamp.gte(1)).sort(Feed.timestamp.desc).take(1).first).toBe(ad);
      expect(Feed.match([Post, (p) => p.title.eq("Hello")], [Ad, () => false]).items).toEqual([
        post,
      ]);
      expect(Feed.instances.select(Feed.timestamp)).toEqual([1, 2]);
      expect(Feed.sort(Feed.timestamp.asc).first).toBe(post);
      expect(Feed.take(1).first).toBe(post);
    });
    scoped(scope(), () => expect(Feed.instances.count).toBe(0));
  });

  it("clears all instances through the unfiltered query", async () => {
    const Task = staticModel({ data: { title: f.string("") } });
    const app = scope();
    const tasks = scoped(app, () => Task.create([{}, {}]));
    await scoped(app, () => Task.instances.remove());
    expect(tasks.every((task) => !task.alive)).toBe(true);
    expect(scoped(app, () => Task.instances.count)).toBe(0);
  });

  it("clears an unfiltered union and waits for asynchronous disposal", async () => {
    const A = model({}),
      B = staticModel({});
    const Feed = union(A, B);
    const app = scope();
    const a = scoped(app, () => A.create({})),
      b = scoped(app, () => B.create({}));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    modelInstanceBindingOf(a)!.beforeDispose(() => gate);
    const completion = scoped(app, () => Feed.instances.remove());
    expect(a.alive).toBe(true);
    expect(b.alive).toBe(false);
    release();
    await completion;
    expect(a.alive).toBe(false);
    expect(scoped(app, () => Feed.instances.count)).toBe(0);
  });
});
