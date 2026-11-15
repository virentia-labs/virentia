/** @jsxImportSource @virentia/ui */
import { children, f, staticModel, type InstanceOf } from "@virentia/core/models";
import { expectTypeOf } from "vitest";
import { component, For, type Readable } from "../../lib";
const Task = staticModel({ data: { title: f.string(), rank: f.number(0) } });
const Board = staticModel({ data: { tasks: children.many(Task) } });
const Row = component({ model: Task, view: (_props, self) => <p>{self.model.title}</p> });
<For each={Task} view={Row} />;
<For each={Task.instances} view={Row} />;
<For each={Task.sort(Task.rank.asc)} view={Row} />;
<For each={Board.create({}).tasks} view={Row} />;
<For each={Task.instances} view={(item: Readable<InstanceOf<typeof Task>>) => {
  expectTypeOf(item.value.title.value).toEqualTypeOf<string>();
  return <p>{item.value.title}</p>;
}} />;
// @ts-expect-error no explicit row keys or matching policy
<For each={Task} view={Row} by={(task: InstanceOf<typeof Task>) => task.id} />;
