import { f, staticModel } from "@virentia/core/models";
import { mutableStore } from "@virentia/mutable";
import { expect } from "vitest";
import { component, createElement as h, For, type Readable } from "../lib";
import { test } from "./support/vitest";

const comments = (parent: Node) =>
  [...parent.childNodes].filter((node) => node.nodeType === 8).length;

test("renders client rows without per-row markers", async ({ root }) => {
  const items = mutableStore(["a", "b", "c"]);
  await root.render(() => h("ul", null, h(For, { each: items, view: (item: Readable<string>) => h("li", null, item) })));
  const list = root.container.querySelector("ul")!;
  expect(list.querySelectorAll("li")).toHaveLength(3);
  // Only the list's own range markers remain.
  expect(comments(list)).toBe(2);
});

test("moves, inserts and removes multi-node and empty rows as whole ranges", async ({ root }) => {
  const items = mutableStore(["a", "", "b", "c"]);
  const view = (item: Readable<string>) => () =>
    item.value ? [h("dt", null, item.value), h("dd", null, item.value.toUpperCase())] : null;
  await root.render(() => h("dl", null, h(For, { each: items, view })));
  const list = root.container.querySelector("dl")!;
  const text = () => [...list.children].map((node) => node.textContent).join(",");
  expect(text()).toBe("a,A,b,B,c,C");
  root.run(() => items.value.reverse());
  expect(text()).toBe("c,C,b,B,a,A");
  root.run(() => items.value.splice(1, 0, "d"));
  expect(text()).toBe("c,C,d,D,b,B,a,A");
  root.run(() => items.value.splice(0, 2));
  expect(text()).toBe("b,B,a,A");
  root.run(() => items.value.push("e"));
  expect(text()).toBe("b,B,a,A,e,E");
  root.run(() => {
    items.value.length = 0;
  });
  expect(list.children).toHaveLength(0);
  expect(comments(list)).toBe(2);
});

test("clears a large model table quickly and completely", async ({ root }) => {
  const Row = staticModel({ data: { label: f.string("") } });
  const View = component({ model: Row, view: (_props, self) => h("tr", null, h("td", null, self.model.label)) });
  await root.render(() => h("table", null, h("tbody", null, h(For, { each: Row, view: View }))));
  root.run(() => Row.create(Array.from({ length: 300 }, (_, i) => ({ id: String(i), label: String(i) }))));
  const body = root.container.querySelector("tbody")!;
  expect(body.querySelectorAll("tr")).toHaveLength(300);
  expect(comments(body)).toBe(2);
  await root.run(() => Row.instances.remove());
  expect(body.querySelectorAll("tr")).toHaveLength(0);
  expect(comments(body)).toBe(2);
  root.run(() => Row.create([{ id: "again", label: "again" }]));
  expect(body.textContent).toBe("again");
});
