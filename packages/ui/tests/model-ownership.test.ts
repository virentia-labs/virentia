import { effect, reaction } from "@virentia/core";
import { children, f, refs, staticModel } from "@virentia/core/models";
import { collection } from "../../core/lib/models/collection";
import { describe, expect } from "vitest";
import { it } from "./support/vitest";
import { component, For, h, ui } from "../lib";

describe("root model ownership", () => {
  it("creates controlled children before DOM and retains them across display changes", async ({ root }) => {
    const Task = staticModel({ data: { title: f.string() } });
    const Board = staticModel({ data: { tasks: children.many(Task) } });
    const Row = component({ model: Task, view: (_props, self) => h("p", null, self.model.title) });
    const board = root.run(() => Board.create({ tasks: [{ id: "a", title: "A" }] }));
    const task = board.tasks.items[0]!;
    await root.render(() => h(For, { each: board.tasks, view: Row }));
    const first = root.container.querySelector("p");
    await root.render(() => null);
    expect(task.alive).toBe(true);
    task.title.value = "saved";
    await root.render(() => h(For, { each: board.tasks, view: Row }));
    expect(root.container.textContent).toBe("saved");
    expect(root.container.querySelector("p")).not.toBe(first);
    await board.dispose();
    expect(task.alive).toBe(false);
    expect(root.container.querySelector("p")).toBeNull();
  });
  it("automatically owns uncontrolled children and scopes their local ids by the parent", async ({ root }) => {
    const ChildModel = staticModel({});
    const Child = component({ model: ChildModel, keep: true, view: () => h("i") });
    const ParentModel = staticModel({});
    const Parent = component({ model: ParentModel, view: () => h(Child, { id: "child" }) });
    const [a, b] = root.run(() => [ParentModel.create({ id: "a" }), ParentModel.create({ id: "b" })]);
    await root.render(() => [h(Parent, { model: a }), h(Parent, { model: b })]);
    const children = collection(ChildModel, root.scope).items;
    expect(children).toHaveLength(2);
    expect(children[0]!.id).not.toBe(children[1]!.id);
    await root.render(() => null);
    expect(children.every((child) => child.alive)).toBe(true);
    await a.dispose();
    expect(children[0]!.alive).toBe(false);
    expect(children[1]!.alive).toBe(true);
  });
  it("rejects a restricted child cascade before lifecycle, model links, or DOM change", async ({ root }) => {
    const called: string[] = [];
    const Task = staticModel({ with: [ui], setup(self) {
      reaction({ on: self.unmounted, run: () => called.push("unmounted") });
    } });
    const Board = staticModel({ data: { tasks: children.many(Task) } });
    const Reference = staticModel({ data: { task: refs.one(Task, { policy: "restrict" }) } });
    const board = root.run(() => Board.create({ tasks: [{ id: "task" }] }));
    const task = board.tasks.items[0]!;
    const link = root.run(() => Reference.create({ task: "task" }));
    const Row = component({ model: Task, view: () => h("input") });
    await root.render(() => h(For, { each: board.tasks, view: Row }));
    const input = root.container.querySelector("input");
    expect(() => board.dispose()).toThrow("restrict");
    expect(() => board.tasks.remove(task)).toThrow("restrict");
    expect(board.tasks.items).toEqual([task]);
    expect(root.container.querySelector("input")).toBe(input);
    expect(called).toEqual([]);
    await link.dispose();
    await board.tasks.remove(task);
    expect(task.alive).toBe(false);
    expect(root.container.querySelector("input")).toBeNull();
    expect(called).toEqual(["unmounted"]);
  });
  it("awaits children.one.clear without dropping its link or refs early", async ({ root }) => {
    let release!: () => void;
    const wait = effect(() => new Promise<void>((resolve) => { release = resolve; }));
    const Task = staticModel({ with: [ui], setup(self) {
      reaction({ on: self.unmounted, run: async () => { await wait(); } });
    } });
    const Board = staticModel({ data: { task: children.one(Task) } });
    const board = root.run(() => Board.create({ task: { id: "child" } }));
    const child = board.task.value!;
    const Row = component({ model: Task, view: () => h("input") });
    await root.render(() => h(Row, { model: child }));
    const clearing = board.task.clear();
    expect(board.task.value).toBe(child);
    expect(child.alive).toBe(true);
    expect(root.container.querySelector("input")).not.toBeNull();
    release();
    await clearing;
    expect(board.task.value).toBeNull();
    expect(child.alive).toBe(false);
    expect(root.container.querySelector("input")).toBeNull();
  });
  it("direct child disposal also removes its owning relation row", async ({ root }) => {
    const Task = staticModel({});
    const Board = staticModel({ data: { tasks: children.many(Task) } });
    const Row = component({ model: Task, view: () => h("p") });
    const board = root.run(() => Board.create({ tasks: [{ id: "a" }] }));
    await root.render(() => h(For, { each: board.tasks, view: Row }));
    await board.tasks.items[0]!.dispose();
    expect(board.tasks.ids).toEqual([]);
    expect(root.container.querySelector("p")).toBeNull();
  });
});
