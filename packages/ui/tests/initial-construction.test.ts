import { reaction, store } from "@virentia/core";
import { f, staticModel } from "@virentia/core/models";
import { expect, vi } from "vitest";
import { component, h, Portal, ref, ui } from "../lib";
import { test } from "./support/vitest";

test("preserves native row insertion order and updates their original text nodes", async ({
  root,
}) => {
  const Model = staticModel({ data: { count: f.number(0) } });
  const Row = component({
    model: Model,
    view: (_props, self) =>
      h("tr", { "data-id": self.id }, h("td", null, self.id), h("td", null, self.model.count)),
  });
  const inserted: string[] = [];
  const append = Node.prototype.appendChild;
  const spy = vi.spyOn(Node.prototype, "appendChild").mockImplementation(function <T extends Node>(
    this: Node,
    child: T,
  ): T {
    if (child.nodeType === 1 && (child as unknown as Element).localName === "tr")
      inserted.push(child.textContent!);
    return append.call(this, child) as T;
  });
  try {
    await root.render(() =>
      h("table", null, h("tbody", null, [h(Row, { id: "a" }), h(Row, { id: "b" })])),
    );
  } finally {
    spy.mockRestore();
  }
  expect(inserted).toEqual(["", ""]);
  const rows = [...root.container.querySelectorAll("tr")];
  const text = rows[1].cells[1].firstChild;
  root.run(() => {
    Model.get("b")!.count.value = 4;
  });
  expect([...root.container.querySelectorAll("tr")]).toEqual(rows);
  expect(rows[1].cells[1].firstChild).toBe(text);
  expect(text!.textContent).toBe("4");
});

test("publishes connected refs before mounted after detached subtree construction", async ({
  root,
}) => {
  const seen: string[] = [];
  const Model = staticModel({
    with: [ui],
    data: { count: f.number(1) },
    setup(self) {
      const target = ref<HTMLElement>();
      reaction({
        on: self.mounted,
        run() {
          expect(target.value!.isConnected).toBe(true);
          seen.push(target.value!.textContent!);
        },
      });
      return { target };
    },
  });
  const Row = component({
    model: Model,
    view: (_props, self) =>
      h("section", { ref: self.model.target }, h("span", null, self.model.count)),
  });
  const instance = root.run(() => Model.create({ id: "row" }));
  await root.render(() => h(Row, { model: instance }));
  expect(seen).toEqual(["1"]);
  const section = instance.target.value;
  instance.count.value = 2;
  expect(instance.target.value).toBe(section);
  expect(section!.textContent).toBe("2");
  await root.render(() => null);
  expect(instance.target.value).toBeNull();
});

test("does not insert a subtree closed by a native child's initial read", async ({ root }) => {
  const Model = staticModel({ data: { count: f.number(0) } });
  const instance = root.run(() => Model.create({ id: "row" }));
  Object.defineProperty(instance.count, "value", {
    get() {
      instance.dispose();
      return "closed";
    },
  });
  const Row = component({
    model: Model,
    view: (_props, self) => h("section", {}, h("span", null, self.model.count)),
  });
  await root.render(() => h(Row, { model: instance }));
  expect(instance.alive).toBe(false);
  expect(root.container.childNodes).toHaveLength(0);
});

test("keeps portal descendants on their existing insertion path during reentrant initial updates", async ({
  root,
}) => {
  const external = root.document.createElement("aside");
  root.document.body.append(external);
  const visible = store(true);
  const inserted: string[] = [];
  const append = Node.prototype.insertBefore;
  const spy = vi.spyOn(Node.prototype, "insertBefore").mockImplementation(function <T extends Node>(
    this: Node,
    child: T,
    before: Node | null,
  ): T {
    if (child.nodeType === 1 && (child as unknown as Element).localName === "section")
      inserted.push(child.textContent!);
    return append.call(this, child, before) as T;
  });
  function Update() {
    visible.value = false;
    visible.value = true;
    return null;
  }
  try {
    await root.render(() =>
      h(
        "main",
        null,
        h(Portal, { mount: external }, () => (visible.value ? h("section", {}, "portal") : null)),
        h(Update, null),
      ),
    );
    expect(inserted).toEqual(["", ""]);
    expect(external.querySelector("section")!.textContent).toBe("portal");
    await root.render(() => null);
    expect(external.childNodes).toHaveLength(0);
  } finally {
    spy.mockRestore();
    external.remove();
  }
});
