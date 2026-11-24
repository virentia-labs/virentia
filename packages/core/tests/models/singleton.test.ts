import { describe, expect, it, vi } from "vitest";
import { computed, effect, event, reaction, scope, scoped, serialize } from "../../lib";
import { children, f, model, staticModel, trait } from "../../lib/models";
import { resolveModelInstance } from "../../lib/models/bindings";

for (const define of [model, staticModel]) {
  describe(`${define.name}.static()`, () => {
    function counter() {
      return define({
        name: "Counter",
        data: { count: f.number(0) },
        setup(self) {
          const add = event<number>();
          reaction({
            on: add,
            run: (value) => {
              self.count.value += value;
            },
          });
          const load = effect(async (value: number) => value);
          reaction({
            on: load.done,
            run: ({ result }) => {
              self.count.value = result;
            },
          });
          return { add, load, doubled: computed(() => self.count.value * 2) };
        },
      });
    }

    it("creates fresh independent native units on every call, without a scope", async () => {
      const Counter = counter();
      const singleton = Counter.static();
      const other = Counter.static();
      expect(Object.is(other, singleton)).toBe(false);
      expect(other.count.node).not.toBe(singleton.count.node);
      expect(other.add.node).not.toBe(singleton.add.node);
      expect(other.load.node).not.toBe(singleton.load.node);
      expect(other.load.pending.node).not.toBe(singleton.load.pending.node);
      expect(other.doubled.node).not.toBe(singleton.doubled.node);
      const app = scope();
      const instance = scoped(app, () => Counter.create({ count: 3 }));
      expect(singleton.count.node).not.toBe(instance.count.node);
      expect(singleton.add.node).not.toBe(instance.add.node);
      const seen: number[] = [];
      const watch = reaction({
        on: singleton.add,
        run: (value) => {
          seen.push(value);
        },
      });
      await scoped(app, () => singleton.add(2));
      await scoped(app, () => other.add(5));
      scoped(app, () => {
        expect(singleton.count.value).toBe(2);
        expect(singleton.doubled.value).toBe(4);
        expect(other.count.value).toBe(5);
        expect(other.doubled.value).toBe(10);
        expect(Counter.instances.items).toEqual([instance]);
      });
      expect(instance.count.value).toBe(3);
      expect(seen).toEqual([2]);
      watch.stop();
    });

    it("isolates state in concurrent scopes while sharing unit identity", async () => {
      const Singleton = counter().static();
      const apps = [scope(), scope()];
      await Promise.all(
        apps.map((app, index) =>
          scoped(app, async () => {
            await Singleton.add(index + 1);
            expect(Singleton.count.value).toBe(index + 1);
            expect(Singleton.doubled.value).toBe((index + 1) * 2);
          }),
        ),
      );
      expect(scoped(apps[0], () => Singleton.count.value)).toBe(1);
      expect(scoped(apps[1], () => Singleton.count.value)).toBe(2);
    });

    it("preserves effect identity for scope handler overrides and pending state", async () => {
      const Counter = counter();
      const Singleton = Counter.static();
      const other = Counter.static();
      const app = scope({ handlers: [[Singleton.load, async (n: number) => n + 10]] });
      await scoped(app, () => Singleton.load(2));
      await scoped(app, () => other.load(2));
      scoped(app, () => {
        expect(Singleton.count.value).toBe(12);
        expect(other.count.value).toBe(2);
        expect(Singleton.load.pending.value).toBe(false);
      });
    });

    it("does not capture the scope that requested the singleton", async () => {
      const Counter = counter();
      const first = scope(),
        second = scope();
      const Singleton = scoped(first, () => Counter.static());
      await scoped(second, () => Singleton.add(4));
      expect(scoped(first, () => Singleton.count.value)).toBe(0);
      expect(scoped(second, () => Singleton.count.value)).toBe(4);
    });

    it("counts and aborts effect calls from different instances in their application scope", async () => {
      let finish!: () => void;
      const gate = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const contexts: unknown[] = [];
      const Singleton = define({
        setup() {
          return {
            wait: effect((_n: number, ctx) => {
              contexts.push(ctx.scope);
              return gate;
            }),
          };
        },
      }).static();
      const Caller = staticModel({
        setup() {
          return { start: effect((n: number) => Singleton.wait(n)) };
        },
      });
      const app = scope();
      const [first, second] = scoped(app, () => Caller.create([{}, {}]));
      const settled = Promise.allSettled([first.start(1), second.start(2)]);
      try {
        expect(contexts).toEqual([app, app]);
        expect(scoped(app, () => Singleton.wait.inFlight.value)).toBe(2);
        await scoped(app, () => Singleton.wait.abort("cancel"));
      } finally {
        finish();
      }
      expect((await settled).map((result) => result.status)).toEqual(["rejected", "rejected"]);
      expect(scoped(app, () => Singleton.wait.pending.value)).toBe(false);
    });

    it("initializes each scope once and preserves scope-provided values", () => {
      const created = vi.fn();
      const Counter = define({
        name: "Initialized",
        data: { count: f.number(1) },
        onCreate(self) {
          created(self.count.value);
          self.count.value += 1;
        },
      });
      const Singleton = Counter.static();
      const mapped = Singleton.count.map((n) => n * 2);
      const app = scope({ values: [[Singleton.count, 10]] });
      scoped(app, () => {
        expect(mapped.value).toBe(22);
        expect(Singleton.count.value).toBe(11);
        expect(Singleton.count.value).toBe(11);
      });
      scoped(scope(), () => expect(Singleton.count.value).toBe(2));
      expect(created.mock.calls).toEqual([[10], [1]]);
    });

    it("runs once on application events even without ordinary instances", async () => {
      const tick = event<number>();
      const Counter = define({
        data: { count: f.number(0) },
        setup(self) {
          reaction({
            on: tick,
            run: (n) => {
              self.count.value += n;
            },
          });
        },
      });
      const Singleton = Counter.static();
      const app = scope();
      await scoped(app, () => tick(2));
      expect(scoped(app, () => Singleton.count.value)).toBe(2);
    });

    it("normalizes access from an ordinary model to its application scope", async () => {
      const Singleton = counter().static();
      const Other = staticModel({
        setup() {
          const update = event<void>();
          reaction({
            on: update,
            run: async () => {
              await Singleton.add(2);
            },
          });
          return { update, result: computed(() => Singleton.doubled.value) };
        },
      });
      const app = scope();
      const other = scoped(app, () => Other.create({}));
      await other.update();
      expect(scoped(app, () => Singleton.doubled.value)).toBe(4);
      expect(other.result.value).toBe(4);
      await scoped(app, () => Singleton.add(1));
      expect(other.result.value).toBe(6);
    });

    it("supports owned children, traits, initialization and per-scope cleanup", async () => {
      const named = trait({ data: { label: f.string("Root") } });
      const Child = model({ data: { title: f.string() } });
      const cleaned: string[] = [];
      const Board = define({
        with: [named],
        data: { tasks: children.many(Child) },
        onCreate(self) {
          self.tasks.add({ title: self.label.value });
          self.onCleanup(() => cleaned.push(self.label.value));
        },
      });
      const Singleton = Board.static();
      const other = Board.static();
      const app = scope();
      const child = scoped(app, () => Singleton.tasks.items[0]);
      const otherChild = scoped(app, () => other.tasks.items[0]);
      expect(otherChild).not.toBe(child);
      expect(child.title.value).toBe("Root");
      await scoped(app, () => Singleton.dispose());
      expect(child.alive).toBe(false);
      expect(otherChild.alive).toBe(true);
      expect(cleaned).toEqual(["Root"]);
    });

    it("serializes with an independent stable address and restores lazily", async () => {
      const Counter = counter();
      const Singleton = Counter.static();
      const other = Counter.static();
      const app = scope();
      const ordinary = scoped(app, () => Counter.create({ count: 3 }));
      await scoped(app, () => Singleton.add(7));
      await scoped(app, () => other.add(11));
      const snapshot = serialize(app);
      // A client bundle recreates declarations; runtime node identity is different.
      const RestoredCounter = counter();
      const restored = RestoredCounter.static();
      const restoredOther = RestoredCounter.static();
      expect(restored.count.node).not.toBe(Singleton.count.node);
      const client = scope({ snapshot });
      expect(scoped(client, () => restored.count.value)).toBe(7);
      expect(scoped(client, () => restoredOther.count.value)).toBe(11);
      expect(scoped(client, () => RestoredCounter.create({ count: 0 }).count.value)).toBe(3);
      expect(ordinary.count.value).toBe(3);
      expect(scoped(client, () => restored.doubled.value)).toBe(14);
      expect(scoped(client, () => restoredOther.doubled.value)).toBe(22);
    });

    it("validates each call's constructor input independently", () => {
      const User = define({ data: { label: f.string() } });
      expect(() => (User.static as () => object)()).toThrow(/requires constructor field/);
      const user = User.static({ label: "Ada" });
      const sameInput = User.static({ label: "Ada" });
      const other = User.static({ label: "Grace" });
      expect(Object.is(sameInput, user)).toBe(false);
      const app = scope();
      scoped(app, () => {
        user.label.value = "Updated";
        expect(sameInput.label.value).toBe("Ada");
        expect(other.label.value).toBe("Grace");
        expect(user.label.value).toBe("Updated");
      });
    });

    it("materializes distinct renderer instances for explicit scopes", () => {
      const Singleton = counter().static();
      const first = scope(),
        second = scope();
      const a = resolveModelInstance(Singleton, first),
        b = resolveModelInstance(Singleton, second);
      expect(a).not.toBe(b);
      expect(resolveModelInstance(Singleton, first)).toBe(a);
      expect(a.count.node).toBe(Singleton.count.node);
      expect(scoped(first, () => a.count.map((count) => count + 1).value)).toBe(1);
    });
  });
}
