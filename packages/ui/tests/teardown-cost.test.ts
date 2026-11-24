import { reaction, store } from "@virentia/core";
import { f, staticModel } from "@virentia/core/models";
import { mutableStore } from "@virentia/mutable";
import { expect, vi } from "vitest";
import { component, For, h, ref, ui, type Readable } from "../lib";
import { test } from "./support/vitest";

const Row = staticModel({ data: { label: f.string("") } });
const RowView = component({
  model: Row,
  view: (_props, self) =>
    h("tr", null, h("td", null, self.id), h("td", null, h("a", null, self.model.label))),
});

function countRemovals(document: Document) {
  const prototype = Object.getPrototypeOf(Object.getPrototypeOf(document.createElement("div")));
  let owner = prototype;
  while (owner && !Object.hasOwn(owner, "removeChild")) owner = Object.getPrototypeOf(owner);
  return vi.spyOn(owner as Node, "removeChild");
}

/** Records `textContent` writes to `element`. */
function countClears(element: Element): string[] {
  const writes: string[] = [];
  let owner = Object.getPrototypeOf(element);
  while (owner && !Object.getOwnPropertyDescriptor(owner, "textContent")) owner = Object.getPrototypeOf(owner);
  const descriptor = Object.getOwnPropertyDescriptor(owner, "textContent")!;
  Object.defineProperty(element, "textContent", {
    configurable: true,
    get() {
      return descriptor.get!.call(this);
    },
    set(value: string) {
      writes.push(value);
      descriptor.set!.call(this, value);
    },
  });
  return writes;
}

test("detaches only the top-level node of an unmounted tree", async ({ root }) => {
  await root.render(() =>
    h(
      "table",
      null,
      h(
        "tbody",
        null,
        Array.from({ length: 3 }, (_, index) => h(RowView, { id: String(index), label: `row ${index}` })),
      ),
    ),
  );
  expect(root.container.querySelectorAll("tr")).toHaveLength(3);
  const removals = countRemovals(root.document);
  try {
    await root.render(() => null);
    expect(root.container.childNodes).toHaveLength(0);
    // Rows, cells and text leave together with <table>.
    expect(removals).toHaveBeenCalledTimes(1);
  } finally {
    removals.mockRestore();
  }
});

test("detaches list rows that leave while their container stays", async ({ root }) => {
  const Item = staticModel({ data: { label: f.string("") } });
  const ItemView = component({ model: Item, view: (_props, self) => h("li", null, self.model.label) });
  await root.render(() => h("ul", null, h(For, { each: Item, view: ItemView })));
  root.run(() => Item.create([{ id: "a", label: "a" }, { id: "b", label: "b" }]));
  const list = root.container.querySelector("ul")!;
  expect(list.textContent).toBe("ab");
  const first = list.querySelector("li")!;
  await root.run(() => Item.instances.remove("a"));
  expect(first.isConnected).toBe(false);
  expect(list.textContent).toBe("b");
  await root.run(() => Item.instances.remove());
  expect(list.querySelectorAll("li")).toHaveLength(0);
  expect(list.isConnected).toBe(true);
});

test("detaches a replaced branch inside a live element", async ({ root }) => {
  const visible = store(true);
  await root.render(() =>
    h("div", null, () => (visible.value ? h("p", null, h("b", null, "shown")) : null)),
  );
  const paragraph = root.container.querySelector("p")!;
  root.run(() => {
    visible.value = false;
  });
  expect(paragraph.isConnected).toBe(false);
  expect(root.container.querySelector("div")!.textContent).toBe("");
});

test("detaches nested nodes that were moved outside their element", async ({ root }) => {
  await root.render(() =>
    h("table", null, h("tbody", null, h(RowView, { id: "moved", label: "label" }))),
  );
  const external = root.document.createElement("aside");
  root.document.body.append(external);
  const link = root.container.querySelector("a")!;
  const cell = root.container.querySelector("td")!;
  external.append(link, cell.firstChild!);
  await root.render(() => null);
  expect(root.container.childNodes).toHaveLength(0);
  expect(external.childNodes).toHaveLength(0);
});

test("empties a list's parent once when every row leaves", async ({ root }) => {
  const Item = staticModel({ data: { label: f.string("") } });
  const ItemView = component({ model: Item, view: (_props, self) => h("li", null, self.model.label) });
  await root.render(() => h("ul", null, h(For, { each: Item, view: ItemView })));
  root.run(() => Item.create(Array.from({ length: 5 }, (_, index) => ({ id: String(index), label: String(index) }))));
  const list = root.container.querySelector("ul")!;
  const rows = [...list.querySelectorAll("li")];
  const clears = countClears(list);
  await root.run(() => Item.instances.remove());
  expect(clears).toEqual([""]);
  expect(rows.some((row) => row.isConnected)).toBe(false);
  expect(list.querySelectorAll("li")).toHaveLength(0);
  // The list keeps working after the parent was emptied.
  root.run(() => Item.create([{ id: "x", label: "x" }]));
  expect(list.textContent).toBe("x");
});

test("removes rows one by one when the list shares its parent", async ({ root }) => {
  const Item = staticModel({ data: { label: f.string("") } });
  const ItemView = component({ model: Item, view: (_props, self) => h("li", null, self.model.label) });
  await root.render(() => h("ul", null, h("li", null, "head"), h(For, { each: Item, view: ItemView })));
  root.run(() => Item.create([{ id: "a", label: "a" }, { id: "b", label: "b" }]));
  const list = root.container.querySelector("ul")!;
  const clears = countClears(list);
  const removals = countRemovals(root.document);
  try {
    await root.run(() => Item.instances.remove());
    expect(removals).toHaveBeenCalledTimes(2);
  } finally {
    removals.mockRestore();
  }
  expect(clears).toEqual([]);
  expect(list.textContent).toBe("head");
});

test("a row's unmounted event still sees its DOM during a bulk removal", async ({ root }) => {
  const seen: string[] = [];
  const Waiting = staticModel({
    with: [ui],
    data: { label: f.string("") },
    setup(self) {
      const item = ref<HTMLLIElement>();
      reaction({
        on: self.unmounted,
        run: () => {
          seen.push(`${self.id}:${String(item.value?.isConnected)}`);
        },
      });
      return { item };
    },
  });
  const WaitingView = component({
    model: Waiting,
    view: (_props, self) => h("li", { ref: self.model.item }, self.model.label),
  });
  await root.render(() => h("ol", null, h(For, { each: Waiting, view: WaitingView })));
  root.run(() => Waiting.create([{ id: "a", label: "a" }, { id: "b", label: "b" }]));
  const list = root.container.querySelector("ol")!;
  await root.run(() => Waiting.instances.remove());
  expect(seen).toEqual(["a:true", "b:true"]);
  expect(list.querySelectorAll("li")).toHaveLength(0);
});

test("detaches a row node moved out of a list that leaves at once", async ({ root }) => {
  const Item = staticModel({ data: { label: f.string("") } });
  const ItemView = component({ model: Item, view: (_props, self) => h("li", null, self.model.label) });
  await root.render(() => h("ul", null, h(For, { each: Item, view: ItemView })));
  root.run(() => Item.create([{ id: "a", label: "a" }, { id: "b", label: "b" }]));
  const external = root.document.createElement("aside");
  root.document.body.append(external);
  external.append(root.container.querySelector("li")!);
  await root.run(() => Item.instances.remove());
  expect(external.childNodes).toHaveLength(0);
  expect(root.container.querySelector("ul")!.childNodes.length).toBeLessThanOrEqual(2);
});

test("closes the rows of a value list as one teardown when all of them leave", async ({ root }) => {
  const items = mutableStore(["a", "b", "c"]);
  await root.render(() =>
    h("ul", null, h(For, { each: items, view: (item: Readable<string>) => h("li", null, item) })),
  );
  const list = root.container.querySelector("ul")!;
  const rows = [...list.querySelectorAll("li")];
  const clears = countClears(list);
  root.run(() => items.value.splice(0, 3));
  expect(clears).toEqual([""]);
  expect(rows.some((row) => row.isConnected)).toBe(false);
  root.run(() => items.value.push("d"));
  expect(list.textContent).toBe("d");
  // Fewer than all rows leave one by one.
  root.run(() => items.value.push("e"));
  root.run(() => items.value.splice(0, 1));
  expect(clears).toEqual([""]);
  expect(list.textContent).toBe("e");
});
