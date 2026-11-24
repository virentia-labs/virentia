import { describe, expect, it, vi } from "vitest";
import { computed, event, reaction, scope, scoped, store } from "../../lib/index";
import { children, f, model, staticModel } from "../../lib/models";
import { collection } from "../../lib/models/collection";

for (const [name, kind] of [
  ["staticModel", staticModel],
  ["model", model],
] as const) {
  const define = kind as typeof staticModel;
  describe(`${name} onCreate`, () => {
    it("initializes fields and members before returning and keeps instance state isolated", async () => {
      const created = vi.fn(),
        cleaned: string[] = [];
      const Task = define({
        data: { title: f.string(), count: f.number(0).local() },
        setup(self) {
          const increment = event<number>();
          reaction({
            on: increment,
            run: (n) => {
              self.count.value += n;
            },
          });
          return { increment, doubled: computed(() => self.count.value * 2) };
        },
        onCreate(self) {
          const title = self.title.value;
          self.count.value = title.length;
          created(self.doubled.value);
          self.onCleanup(() => cleaned.push(title));
        },
      });
      const [a, b] = scoped(scope(), () => [
        Task.create({ title: "one" }),
        Task.create({ title: "longer" }),
      ]);
      expect(a.count.value).toBe(3);
      expect(b.count.value).toBe(6);
      expect(created.mock.calls).toEqual([[6], [12]]);
      await a.increment(1);
      expect(a.doubled.value).toBe(8);
      expect(b.doubled.value).toBe(12);
      await a.dispose();
      expect(cleaned).toEqual(["one"]);
      await b.dispose();
      expect(cleaned).toEqual(["one", "longer"]);
    });

    it("runs once for a new identity through create/add and never for an upsert", () => {
      const created = vi.fn();
      const Item = define({ data: { title: f.string("") }, onCreate: created });
      scoped(scope(), () => {
        const items = collection(Item);
        const a = Item.create({ id: "a", title: "first" });
        expect(items.add({ id: "a", title: "second" })).toBe(a);
        expect(Item.create({ id: "a", title: "third" })).toBe(a);
        expect(created).toHaveBeenCalledTimes(1);
        items.add([{ id: "b" }, { id: "c" }]);
        expect(created).toHaveBeenCalledTimes(3);
      });
    });

    it("runs after child initialization and relation hydration", () => {
      const order: string[] = [];
      const Child = define({
        data: { title: f.string(), ready: f.boolean(false).local() },
        onCreate(self) {
          self.ready.value = true;
          order.push(self.title.value);
        },
      });
      const Parent = define({
        data: { children: children.many(Child) },
        onCreate(self) {
          expect(self.children.items.every((child) => child.ready.value)).toBe(true);
          order.push("parent");
        },
      });
      scoped(scope(), () => Parent.create({ children: [{ title: "a" }, { title: "b" }] }));
      expect(order).toEqual(["a", "b", "parent"]);
    });

    it("cleans resources and removes a failed instance when initialization throws", () => {
      const cleaned = vi.fn();
      let failed: { alive: boolean } | undefined;
      const Broken = define({
        onCreate(self) {
          failed = self;
          self.onCleanup(cleaned);
          throw Error("initialization failed");
        },
      });
      scoped(scope(), () => {
        expect(() => Broken.create({})).toThrow("initialization failed");
        expect(collection(Broken).count).toBe(0);
      });
      expect(failed?.alive).toBe(false);
      expect(cleaned).toHaveBeenCalledOnce();
    });

    it("keeps unit declarations in setup and rejects asynchronous initialization", () => {
      const DeclaresUnit = define({
        onCreate() {
          store(0);
        },
      });
      const Async = define({
        onCreate() {
          return Promise.resolve();
        },
      });
      scoped(scope(), () => {
        expect(() => DeclaresUnit.create({})).toThrow(/onCreate cannot declare a store/);
        expect(collection(DeclaresUnit).count).toBe(0);
        expect(() => Async.create({})).toThrow(/onCreate must be synchronous/);
        expect(collection(Async).count).toBe(0);
      });
    });

    it("allows initialization to create a child whose dynamic setup declares units", () => {
      const Child = model({
        setup() {
          return { count: store(1) };
        },
      });
      const Parent = define({
        data: { child: children.one(Child) },
        onCreate(self) {
          self.child.create({});
        },
      });
      scoped(scope(), () => {
        expect(Parent.create({}).child.value?.count.value).toBe(1);
      });
    });
  });
}
