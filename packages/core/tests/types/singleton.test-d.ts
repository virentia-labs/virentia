import { expectTypeOf } from "vitest";
import { computed, effect, event, reaction, type StoreWritable } from "../../lib";
import {
  children,
  f,
  model,
  staticModel,
  type InstanceOf,
  type SingletonOf,
} from "../../lib/models";

const Child = model({ data: { label: f.string() } });
const Counter = staticModel({
  data: { count: f.number(0), tasks: children.many(Child) },
  setup(self) {
    const add = event<number>();
    reaction({
      on: add,
      run: (value) => {
        self.count.value += value;
      },
    });
    return {
      add,
      load: effect(async (n: number) => n * 2),
      doubled: computed(() => self.count.value * 2),
    };
  },
});
const counter = Counter.static();
expectTypeOf(counter).toEqualTypeOf<SingletonOf<typeof Counter>>();
expectTypeOf(counter.count).toEqualTypeOf<StoreWritable<number>>();
expectTypeOf(counter.add).toEqualTypeOf<ReturnType<typeof event<number>>>();
expectTypeOf(counter.load).toEqualTypeOf<ReturnType<typeof effect<number, number>>>();
expectTypeOf(counter.tasks.add({ label: "Child" })).toEqualTypeOf<InstanceOf<typeof Child>>();
counter.count.map((count) => String(count));
reaction({
  on: counter.count,
  run: (count) => {
    expectTypeOf(count).toEqualTypeOf<number>();
  },
});
counter.add(2);
// @ts-expect-error a numeric store remains numeric
counter.count.value = "wrong";
// @ts-expect-error an event retains its payload type
counter.add("wrong");
const User = model({ data: { label: f.string() } });
// @ts-expect-error required constructor fields need an initial value
User.static();
// @ts-expect-error constructor values retain their wire types
User.static({ label: 2 });
User.static({ label: "Ada" });
