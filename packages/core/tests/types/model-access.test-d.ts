import { expectTypeOf } from "vitest";
import {
  f,
  model,
  staticModel,
  trait,
  union,
  type InstanceOf,
  type TypedQuery,
} from "../../lib/models";

const Task = staticModel({
  data: { title: f.string(), count: f.number(0), done: f.boolean(false) },
});
const DynamicTask = model({ data: { title: f.string() } });

expectTypeOf(Task.get("a")).toEqualTypeOf<InstanceOf<typeof Task> | null>();
expectTypeOf(Task.create({ title: "A" })).toEqualTypeOf<InstanceOf<typeof Task>>();
expectTypeOf(Task.create([{ title: "A" }])).toEqualTypeOf<InstanceOf<typeof Task>[]>();
expectTypeOf(DynamicTask.get("a")).toEqualTypeOf<InstanceOf<typeof DynamicTask> | null>();
expectTypeOf(Task.instances).toEqualTypeOf<TypedQuery<InstanceOf<typeof Task>>>();
expectTypeOf(Task.instances.count).toEqualTypeOf<number>();
expectTypeOf(
  Task.where(Task.done.eq(false)).sort(Task.count.desc).take(1).first,
).toEqualTypeOf<InstanceOf<typeof Task> | null>();
expectTypeOf(Task.instances.select(Task.title)).toEqualTypeOf<string[]>();
Task.where((task) => task.count.value > 0).set(Task.done, true);
Task.create({ id: "a", done: true });

// @ts-expect-error create still requires the model's wire input
Task.create({ title: 1 });
// @ts-expect-error a batch has the same input constraints
Task.create([{ title: 1 }]);
// @ts-expect-error get accepts an ID, not constructor input
Task.get({ id: "a" });
// @ts-expect-error query projection retains the field type
Task.where(Task.done.eq(false)).set(Task.count, "wrong");

const Ranked = trait({ data: { rank: f.number(0) } });
const A = model({ with: [Ranked], data: { title: f.string() } });
const B = staticModel({ with: [Ranked], data: { budget: f.number() } });
const ReadOnlyUnion = union(A, B);
// @ts-expect-error unions need a discriminator to create instances
ReadOnlyUnion.create({ title: "A" });
const Feed = ReadOnlyUnion.by((input) => ("title" in input ? A : B));
expectTypeOf(Feed.get("a")).toEqualTypeOf<InstanceOf<typeof A> | InstanceOf<typeof B> | null>();
expectTypeOf(Feed.create({ title: "A" })).toEqualTypeOf<
  InstanceOf<typeof A> | InstanceOf<typeof B>
>();
expectTypeOf(Feed.create([{ budget: 1 }])).toEqualTypeOf<
  (InstanceOf<typeof A> | InstanceOf<typeof B>)[]
>();
Feed.where(Feed.rank.gte(1)).sort(Feed.rank.desc).take(1);
Feed.match([A, (a) => a.title.eq("A")], [B, (b) => b.budget.gt(0)]);
// @ts-expect-error match stays exhaustive
Feed.match([A, () => true]);
