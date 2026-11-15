import { expect, it, vi } from "vitest";
import { reaction, scope, scoped, serialize } from "../../lib";
import { f, refs, staticModel } from "../../lib/models";
import { modelDefinitionBindingOf } from "../../lib/internal";

it("subscribes shared static fields once rather than once per application", () => {
  const Row = staticModel({ data: { rank: f.number(0).indexed() } });
  const native = Row.fields.get("rank")!.staticStore!;
  const subscribe = vi.spyOn(native.node as unknown as { subscribe(...args: unknown[]): unknown }, "subscribe");
  try {
    const apps = Array.from({ length: 32 }, () => scope());
    const rows = apps.map((app) => scoped(app, () => Row.create({ id: "same" })));
    expect(subscribe).toHaveBeenCalledTimes(1);
    rows[0].rank.value = 7;
    rows[15].rank.value = 3;
    for (let i = 0; i < apps.length; i++) {
      const expected = i === 0 ? 7 : i === 15 ? 3 : 0;
      expect(scoped(apps[i], () => Row.where(Row.rank.eq(expected)).first)).toBe(rows[i]);
      expect(rows[i].rank.value).toBe(expected);
    }
  } finally {
    subscribe.mockRestore();
  }
});

it("publishes query changes only in the instance's registry", async () => {
  const Row = staticModel({ data: { done: f.boolean(false).indexed() } });
  const apps = [scope(), scope()];
  const rows = apps.map((app) => scoped(app, () => Row.create({ id: "same" })));
  const seen: number[][] = [[], []];
  const observers = apps.map((app, i) =>
    reaction({
      scope: app,
      run() {
        seen[i].push(Row.where(Row.done.eq(true)).count);
      },
    }),
  );
  rows[0].done.value = true;
  expect(seen).toEqual([[0, 1], [0]]);
  await rows[0].dispose();
  rows[1].done.value = true;
  expect(seen).toEqual([
    [0, 1, 0],
    [0, 1],
  ]);
  for (const observer of observers) observer.stop();
});

it("routes relation updates across scopes without duplicating relation subscriptions", () => {
  const Child = staticModel({ data: { title: f.string("") } });
  const Parent = staticModel({ data: { children: refs.many(Child) } });
  const unit = Parent.relations.get("children")!.staticStore!;
  const subscribe = vi.spyOn(unit.node as unknown as { subscribe(...args: unknown[]): unknown }, "subscribe");
  try {
    const apps = [scope(), scope()];
    const rows = apps.map((app) =>
      scoped(app, () => {
        const child = Child.create({ id: "child" });
        return { child, parent: Parent.create({ id: "parent" }) };
      }),
    );
    expect(subscribe).toHaveBeenCalledTimes(1);
    rows[0].parent.children.add(rows[0].child);
    expect(rows[0].parent.children.items).toEqual([rows[0].child]);
    expect(rows[1].parent.children.items).toEqual([]);
  } finally {
    subscribe.mockRestore();
  }
});

it("retains singleton registry routing and SSR field namespaces in independent scopes", () => {
  const Row = staticModel({ name: "SharedRouting", data: { count: f.number(0).indexed() } });
  const left = Row.static(),
    right = Row.static();
  const apps = [scope(), scope()];
  scoped(apps[0], () => {
    left.count.value = 1;
    right.count.value = 2;
  });
  scoped(apps[1], () => {
    left.count.value = 3;
    right.count.value = 4;
  });
  expect(apps.map((app) => scoped(app, () => [left.count.value, right.count.value]))).toEqual([
    [1, 2],
    [3, 4],
  ]);
  for (const app of apps) {
    const snapshot = serialize(app);
    const restored = scope({ snapshot });
    expect(scoped(restored, () => [left.count.value, right.count.value])).toEqual(
      scoped(app, () => [left.count.value, right.count.value]),
    );
    expect(serialize(restored)).toEqual(snapshot);
  }
});

it("rolls back partial shared subscriptions after an initialization error", () => {
  const Row = staticModel({ data: { a: f.number(0), b: f.number(0) } });
  const first = Row.fields.get("a")!.staticStore!;
  const second = Row.fields.get("b")!.staticStore!;
  // A store's members call its node: spy there (the store is a plain object).
  type Subscribable = { subscribe(fn: (value: number) => void): () => void };
  const firstNode = first.node as unknown as Subscribable;
  const original = firstNode.subscribe.bind(firstNode);
  const stopped = vi.fn();
  const a = vi.spyOn(firstNode, "subscribe").mockImplementation((fn) => {
    const off = original(fn);
    return () => {
      stopped();
      off();
    };
  });
  const b = vi.spyOn(second.node as unknown as Subscribable, "subscribe").mockImplementationOnce(() => {
    throw Error("subscription failed");
  });
  try {
    expect(() => modelDefinitionBindingOf(Row)!.collection(scope())).toThrow("subscription failed");
    expect(stopped).toHaveBeenCalledTimes(1);
    const row = scoped(scope(), () => Row.create({ id: "row" }));
    row.a.value = 1;
    row.b.value = 2;
    expect([row.a.value, row.b.value]).toEqual([1, 2]);
    expect(a).toHaveBeenCalledTimes(2);
    expect(b).toHaveBeenCalledTimes(2);
  } finally {
    a.mockRestore();
    b.mockRestore();
  }
});
