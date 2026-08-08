import { describe, expect, it } from "vitest";
import { computed, event, reaction, scope, scoped } from "../../lib/index";
import { collection, f, model, staticModel } from "../../lib/models";

// §3.5: under churn a collection recycles instance scopes — Scope + Map are
// reused (`clear()` instead of a new one). Safety: the handle is
// { slot, generation }, stale access says "entity was disposed" instead of
// reading the next occupant's data, `alive` is a cheap REACTIVE check, and the
// dispose error carries the dispose site.

function app<T>(fn: () => T): T {
  return scoped(scope(), fn) as T;
}

function keyParts(key: string): { slot: number; generation: number } {
  const match = /^s(\d+)g(\d+)$/.exec(key);

  expect(match).not.toBeNull();

  return { slot: Number(match![1]), generation: Number(match![2]) };
}

const microtask = () => Promise.resolve();

describe("§3.5 scope reuse and generations", () => {
  it("a freed scope is reused: same slot, bumped generation", async () => {
    const Todo: any = staticModel({ data: { title: f.string("") } });

    await app(async () => {
      const todos: any = collection(Todo);
      const first = todos.add({});
      const firstKey = keyParts(first.key);

      expect(firstKey.generation).toBe(1);

      todos.remove(first.id);
      await microtask(); // the scope joins the free list a microtask later

      const second = todos.add({});
      const secondKey = keyParts(second.key);

      expect(secondKey.slot).toBe(firstKey.slot);
      expect(secondKey.generation).toBe(firstKey.generation + 1);
    });
  });

  it("a same-tick create does NOT reuse the just-freed scope", () => {
    const Todo: any = staticModel({ data: { title: f.string("") } });

    app(() => {
      const todos: any = collection(Todo);
      const first = todos.add({});

      todos.remove(first.id);

      const second = todos.add({}); // synchronously — pending reactions may still drain

      expect(keyParts(second.key).slot).not.toBe(keyParts(first.key).slot);
      expect(keyParts(second.key).generation).toBe(1);
    });
  });

  it("generations increment monotonically across reuse cycles", async () => {
    const Todo: any = staticModel({ data: { title: f.string("") } });

    await app(async () => {
      const todos: any = collection(Todo);
      const generations: number[] = [];
      let slot: number | undefined;

      for (let cycle = 0; cycle < 3; cycle += 1) {
        const t = todos.add({});
        const parts = keyParts(t.key);

        slot ??= parts.slot;

        expect(parts.slot).toBe(slot);
        generations.push(parts.generation);

        todos.remove(t.id);
        await microtask();
      }

      expect(generations).toEqual([1, 2, 3]);
    });
  });

  it("a stale facade throws instead of reading the next occupant, even with the same id", async () => {
    const Todo: any = staticModel({ data: { title: f.string("") } });

    await app(async () => {
      const todos: any = collection(Todo);
      const first = todos.add({ id: "x", title: "first" });

      todos.remove("x");
      await microtask();

      const second = todos.add({ id: "x", title: "second" }); // reuses the scope AND the id

      expect(keyParts(second.key).slot).toBe(keyParts(first.key).slot);
      expect(second.key).not.toBe(first.key); // the generation tells them apart

      expect(() => first.title.value).toThrowError(/entity was disposed/);
      expect(first.alive).toBe(false); // alive never throws (§3.5)
      expect(second.title.value).toBe("second");
    });
  });

  it("reused scopes start from a clean slate: defaults, not the previous values", async () => {
    const Todo: any = staticModel({
      data: { title: f.string(""), done: f.boolean(false) },
    });

    await app(async () => {
      const todos: any = collection(Todo);
      const first = todos.add({ title: "dirty", done: true });

      todos.remove(first.id);
      await microtask();

      const second = todos.add({});

      expect(keyParts(second.key).generation).toBe(2);
      expect(second.title.value).toBe("");
      expect(second.done.value).toBe(false);
    });
  });

  it("a reused instance is fully functional: units, indexes, queries", async () => {
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
      const first = todos.add({});

      await first.toggled();
      todos.remove(first.id);
      await microtask();

      const second = todos.add({});
      const bystander = todos.add({});

      expect(second.done.value).toBe(false); // not the previous occupant's true

      await second.toggled();

      expect(second.done.value).toBe(true);
      expect(bystander.done.value).toBe(false);
      expect(todos.where(Todo.done.eq(true)).ids).toEqual([second.id]);
    });
  });

  it("free lists are per collection: another model never inherits the scope", async () => {
    const A: any = staticModel({ data: { a: f.number(0) } });
    const B: any = staticModel({ data: { b: f.number(0) } });

    await app(async () => {
      const as: any = collection(A);
      const bs: any = collection(B);
      const first = as.add({});

      as.remove(first.id);
      await microtask();

      const other = bs.add({});

      expect(keyParts(other.key).slot).not.toBe(keyParts(first.key).slot);
      expect(keyParts(other.key).generation).toBe(1);
    });
  });

  it("dynamic instances are not pooled — fresh slot every time", async () => {
    const Task: any = model({ data: { title: f.string("") } });

    await app(async () => {
      const tasks: any = collection(Task);
      const first = tasks.add({});

      tasks.remove(first.id);
      await microtask();

      const second = tasks.add({});

      expect(keyParts(second.key).slot).not.toBe(keyParts(first.key).slot);
      expect(keyParts(second.key).generation).toBe(1);
    });
  });
});

describe("§3.5 reactive alive", () => {
  it("a reaction over item.alive re-runs when the item is disposed", async () => {
    const Todo: any = staticModel({ data: { title: f.string("") } });

    await app(async () => {
      const todos: any = collection(Todo);
      const t = todos.add({});
      const states: boolean[] = [];

      reaction(() => {
        states.push(t.alive);
      });

      await microtask();

      todos.remove(t.id);

      await microtask();
      await microtask();

      expect(states[0]).toBe(true);
      expect(states.at(-1)).toBe(false);
    });
  });

  it("a computed over alive degrades without a try", () => {
    const Todo: any = staticModel({ data: { title: f.string("") } });

    app(() => {
      const todos: any = collection(Todo);
      const t = todos.add({});
      const label = computed(() => (t.alive ? t.title.value : "gone"));

      expect(label.value).toBe("");

      todos.remove(t.id);

      expect(label.value).toBe("gone"); // no try/catch around the read needed
    });
  });
});

describe("§3.5 dispose site in the stale-access error", () => {
  it("the error names where the dispose happened", () => {
    const Todo: any = staticModel({ data: { title: f.string("") } });

    app(() => {
      const todos: any = collection(Todo);
      const t = todos.add({});

      function killItFromHere(): void {
        todos.remove(t.id);
      }

      killItFromHere();

      try {
        t.title.value;
        expect.unreachable("stale access must throw");
      } catch (error) {
        expect((error as Error).message).toMatch(/entity was disposed — disposed at/);
        expect((error as Error).message).toMatch(/killItFromHere/);
      }
    });
  });
});
