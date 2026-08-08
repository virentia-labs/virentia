import { describe, expect, it } from "vitest";
import { computed, scope, scoped } from "../../lib/index";
import type { Scope } from "../../lib/index";
import { getInspectorScopeId } from "../../lib/kernel/inspector";
import {
  collection,
  f,
  isModelInstance,
  isModelQuery,
  model,
  modelsInspectorSnapshot,
  queryReactivity,
  staticModel,
  subscribeInstance,
  union,
} from "../../lib/models";

// §10.1 seams the bindings build on, §10.3 inspector aggregation.

function app<T>(fn: () => T): T {
  return scoped(scope(), fn) as T;
}

describe("§10.1 reactive get(id)", () => {
  it("a computed over get(id) re-resolves on add, dispose and rebind", () => {
    const Todo: any = staticModel({ data: { title: f.string("") } });

    app(() => {
      const todos: any = collection(Todo);
      const view = computed(() => todos.get("t1"));

      expect(view.value).toBeNull();

      const t = todos.add({ id: "t1" });

      expect(view.value).toBe(t);

      t.rebind("t2");

      expect(view.value).toBe(t); // old id resolves through forwarding (§10.1)

      todos.remove("t2");

      expect(view.value).toBeNull(); // null, not a throw, mid-read
    });
  });
});

describe("§10.1 markers and helpers", () => {
  it("classifies instances and queries; queryReactivity exposes the epochs", () => {
    const Todo: any = staticModel({ data: { title: f.string("") } });
    const Ad: any = staticModel({ data: { budget: f.number(0) } });
    const Feed: any = (union(Todo, Ad) as any).by(() => Todo);

    app(() => {
      const todos: any = collection(Todo);
      const feed: any = collection(Feed);
      const t = todos.add({});

      expect(isModelInstance(t)).toBe(true);
      expect(isModelInstance({})).toBe(false);

      expect(isModelQuery(todos)).toBe(true);
      expect(isModelQuery(todos.where(() => true))).toBe(true);
      expect(isModelQuery(feed)).toBe(true);
      expect(isModelQuery(t)).toBe(false);

      expect(queryReactivity(todos).versions).toHaveLength(1);
      expect(queryReactivity(feed).versions).toHaveLength(2); // one per variant

      expect(() => queryReactivity({})).toThrowError(/collection query/);
    });
  });

  it("subscribeInstance fires on own writes, dispose and rebind — not on neighbors", () => {
    const Todo: any = staticModel({ data: { title: f.string("") } });

    app(() => {
      const todos: any = collection(Todo);
      const mine: any = todos.add({});
      const neighbor: any = todos.add({});
      let fired = 0;

      const unsubscribe = subscribeInstance(mine, () => {
        fired += 1;
      });

      neighbor.title.value = "noise";

      expect(fired).toBe(0);

      mine.title.value = "own write";

      expect(fired).toBe(1);

      mine.rebind("named");

      expect(fired).toBe(2);

      todos.remove("named");

      expect(fired).toBe(3);

      unsubscribe();
      neighbor.title.value = "more noise";

      expect(fired).toBe(3);
    });
  });

  it("works for dynamic instances too", () => {
    const Task: any = model({ data: { title: f.string("") } });

    app(() => {
      const tasks: any = collection(Task);
      const a: any = tasks.add({});
      const b: any = tasks.add({});
      let fired = 0;

      subscribeInstance(a, () => {
        fired += 1;
      });

      b.title.value = "noise";

      expect(fired).toBe(0);

      a.title.value = "own";

      expect(fired).toBe(1);
    });
  });
});

describe("§10.3 inspector", () => {
  it("instance scopes alias to the application scope — devtools never sees them", () => {
    const Todo: any = staticModel({ data: { title: f.string("") } });
    const application = scope();

    scoped(application, () => {
      const todos: any = collection(Todo);
      const t: any = todos.add({});
      let instanceScope: Scope | null = null;

      t.title.subscribe((_value: unknown, writeScope: Scope) => {
        instanceScope = writeScope;
      });

      t.title.value = "x";

      expect(instanceScope).not.toBeNull();
      expect(instanceScope).not.toBe(application); // it IS a distinct scope...
      expect(getInspectorScopeId(instanceScope!)).toBe(getInspectorScopeId(application)); // ...but devtools attributes it upward (§10.3)
    });
  });

  it("modelsInspectorSnapshot aggregates counts, indexes, plans and pool depth", async () => {
    const Todo: any = staticModel({
      data: { title: f.string(""), done: f.boolean(false).indexed(), rank: f.number(0).indexed("ord") },
      name: "todo",
    });
    const application = scope();

    await scoped(application, async () => {
      const todos: any = collection(Todo);

      todos.add([{ title: "a" }, { title: "b" }]);
      todos.where(Todo.done.eq(true)).items; // interns one plan

      const killed = todos.add({});

      todos.remove(killed.id);
      await Promise.resolve(); // the freed scope joins the pool a microtask later

      const [stats] = modelsInspectorSnapshot(application);

      expect(stats.model).toBe("todo");
      expect(stats.kind).toBe("static");
      expect(stats.count).toBe(2);
      expect(stats.indexes).toContainEqual({ field: "done", kind: "eq", size: expect.any(Number) });
      expect(stats.indexes).toContainEqual({ field: "rank", kind: "ord", size: 2 });
      expect(stats.plans).toBeGreaterThanOrEqual(1);
      expect(stats.pooledScopes).toBe(1);
    });
  });
});
