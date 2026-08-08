import { describe, expect, it } from "vitest";
import { event, reaction, scope, scoped, store } from "../../lib/index";
import { collection, f, staticModel } from "../../lib/models";

// §3.4: one semantics, two implementations — a static model's reaction on an
// EXTERNAL store fires for every live instance, in each instance's scope; own
// units keep the per-instance path. §4.8: add() validates wire input by schema.

function app<T>(fn: () => T): T {
  return scoped(scope(), fn) as T;
}

describe("§3.4 broadcast reactions", () => {
  it("a reaction on an external store fires per live instance", async () => {
    const filter = store("all");

    const Todo: any = staticModel({
      data: { title: f.string(), visible: f.boolean(true) },
      setup(self: any) {
        reaction({
          on: filter,
          run: (value) => {
            self.visible.value = self.title.value.includes(value as string);
          },
        });
      },
    });

    await app(async () => {
      const todos: any = collection(Todo);
      const a = todos.add({ title: "buy milk" });
      const b = todos.add({ title: "call mom" });

      filter.value = "milk";

      await Promise.resolve();
      await Promise.resolve();

      expect(a.visible.value).toBe(true);
      expect(b.visible.value).toBe(false);

      filter.value = "call";

      await Promise.resolve();
      await Promise.resolve();

      expect(a.visible.value).toBe(false);
      expect(b.visible.value).toBe(true);
    });
  });

  it("no instances — no runs; disposed instances are skipped", async () => {
    const ping = store(0);
    const seen: string[] = [];

    const Todo: any = staticModel({
      data: { title: f.string() },
      setup(self: any) {
        reaction({
          on: ping,
          run: () => {
            seen.push(self.title.value);
          },
        });
      },
    });

    await app(async () => {
      const todos: any = collection(Todo);

      ping.value = 1; // no instances yet

      await Promise.resolve();
      await Promise.resolve();

      expect(seen).toEqual([]);

      const a = todos.add({ title: "a" });
      const b = todos.add({ title: "b" });

      todos.remove(a.id);
      ping.value = 2;

      await Promise.resolve();
      await Promise.resolve();

      expect(seen).toEqual(["b"]);
      void b;
    });
  });

  it("own events keep the per-instance path with the router active", async () => {
    const seen: string[] = [];

    const Todo: any = staticModel({
      data: { title: f.string() },
      setup(self: any) {
        const poke = event<void>();

        reaction({
          on: poke,
          run: () => {
            seen.push(self.title.value);
          },
        });

        return { poke };
      },
    });

    await app(async () => {
      const todos: any = collection(Todo);
      const a = todos.add({ title: "a" });

      todos.add({ title: "b" });

      await a.poke();

      expect(seen).toEqual(["a"]); // no fan-out for an own unit
    });
  });

  it("a write from a foreign instance scope normalizes up and fans out (§3.4)", async () => {
    const counter = store(0);
    const seen: string[] = [];

    const Watcher: any = staticModel({
      data: { tag: f.string() },
      setup(self: any) {
        reaction({
          on: counter,
          run: () => {
            seen.push(self.tag.value);
          },
        });
      },
    });

    const Writer: any = staticModel({
      data: { n: f.number(0) },
      setup() {
        const bump = event<void>();

        reaction({
          on: bump,
          run: () => {
            counter.value = counter.value + 1; // lands in the APP scope (§3.2)
          },
        });

        return { bump };
      },
    });

    await app(async () => {
      const watchers: any = collection(Watcher);
      const writers: any = collection(Writer);

      watchers.add({ tag: "w1" });
      watchers.add({ tag: "w2" });

      const writer = writers.add({});

      await writer.bump();
      await Promise.resolve();
      await Promise.resolve();

      expect(seen.sort()).toEqual(["w1", "w2"]);
    });
  });

  it("scope isolation: the broadcast walks only the writing scope's collection", async () => {
    const flag = store(false);
    const seen: string[] = [];

    const Todo: any = staticModel({
      data: { title: f.string() },
      setup(self: any) {
        reaction({
          on: flag,
          run: () => {
            seen.push(self.title.value);
          },
        });
      },
    });

    const first = scope();
    const second = scope();

    scoped(first, () => {
      collection(Todo).add({ title: "in-first" });
    });
    scoped(second, () => {
      collection(Todo).add({ title: "in-second" });
    });

    await scoped(first, async () => {
      flag.value = true;

      await Promise.resolve();
      await Promise.resolve();
    });

    expect(seen).toEqual(["in-first"]);
  });
});

describe("§4.8 input validation by TypeBox schema", () => {
  it("rejects a wrong-typed present key, naming the key and model", () => {
    const Todo: any = staticModel({
      data: { title: f.string(), count: f.number(0) },
      name: "todo",
    });

    app(() => {
      const todos: any = collection(Todo);

      expect(() => todos.add({ title: 42 })).toThrowError(/invalid "title" for todo/);
      expect(() => todos.add({ title: "ok", count: "not-a-number" })).toThrowError(
        /invalid "count"/,
      );
      expect(todos.count).toBe(0); // nothing was created
    });
  });

  it("accepts valid wire input, including ISO date strings", () => {
    const Todo: any = staticModel({
      data: { title: f.string(), due: f.date() },
    });

    app(() => {
      const todos: any = collection(Todo);
      const t = todos.add({ title: "x", due: "2026-08-08T10:00:00.000Z" });

      expect(t.due.value).toBeInstanceOf(Date);
      expect(() => todos.add({ title: "y", due: "not-a-date" })).toThrowError(/invalid "due"/);
    });
  });

  it("optional null passes; merge path validates too", () => {
    const Todo: any = staticModel({
      data: { title: f.string(), due: f.date().optional() },
    });

    app(() => {
      const todos: any = collection(Todo);
      const t = todos.add({ id: "1", title: "x", due: null });

      expect(t.due.value).toBeNull();
      expect(() => todos.add({ id: "1", title: 7 })).toThrowError(/invalid "title"/);
      expect(t.title.value).toBe("x"); // merge aborted before writing
    });
  });

  it("enum schemas validate against their literals", () => {
    const Todo: any = staticModel({
      data: { status: f.enum(["open", "closed"], "open") },
    });

    app(() => {
      const todos: any = collection(Todo);

      todos.add({ status: "closed" });
      expect(() => todos.add({ status: "pending" })).toThrowError(/invalid "status"/);
    });
  });
});
