import { effect, store } from "@virentia/core";
import { f, staticModel } from "@virentia/core/models";
import {
  getInspectorSnapshot,
  onInspectorEvent,
  readInspectorNodeMeta,
} from "../../core/lib/kernel/inspector";
import { expect, vi } from "vitest";
import { component, h, type Child } from "../lib";
import { test } from "./support/vitest";

test("removes an owned root text binding even after its text is moved outside the root", async ({
  root,
}) => {
  const value = store("first");
  await root.render(() => value);
  const text = root.container.firstChild!;
  const external = root.document.createElement("aside");
  root.document.body.append(external);
  external.append(text);
  root.run(() => {
    value.value = "second";
  });
  expect(text.textContent).toBe("second");
  await root.render(() => null);
  expect(external.childNodes).toHaveLength(0);
  root.run(() => {
    value.value = "third";
  });
  expect(text.textContent).toBe("second");
});

test("retains owned-text cleanup when late inspection updates metadata and freezes the binding", async ({
  root,
}) => {
  const value = store("first");
  await root.render(() => value);
  const text = root.container.firstChild!;
  let frozen = 0;
  const stop = onInspectorEvent((event) => {
    if (
      event.type === "node-created" &&
      readInspectorNodeMeta(event.node).description === "DOM binding"
    ) {
      event.node.meta = { ...event.node.meta };
      Object.freeze(event.node);
      frozen++;
    }
  });
  try {
    getInspectorSnapshot();
  } finally {
    stop();
  }
  expect(frozen).toBe(1);
  root.run(() => {
    value.value = "second";
  });
  expect(text.textContent).toBe("second");
  const external = root.document.createElement("aside");
  root.document.body.append(external);
  external.append(text);
  await root.render(() => null);
  expect(external.childNodes).toHaveLength(0);
});

test("discovers the actual dependencies of a customized field getter", async ({ root }) => {
  const Model = staticModel({
    data: { count: f.number(0) },
    setup(self) {
      const alternate = store(3);
      // A value store's api lives on its prototype: the customization keeps it.
      Object.setPrototypeOf(
        self.count,
        Object.create(Object.getPrototypeOf(self.count), {
          value: { get: () => alternate.value, configurable: true },
        }),
      );
      return { alternate };
    },
  });
  const View = component({ model: Model, view: (_props, self) => h("p", null, self.model.count) });
  const instance = root.run(() => Model.create({ id: "row" }));
  await root.render(() => h(View, { model: instance }));
  const text = root.container.querySelector("p")!.firstChild;
  expect(text!.textContent).toBe("3");
  instance.alternate.value = 4;
  expect(root.container.querySelector("p")!.firstChild).toBe(text);
  expect(text!.textContent).toBe("4");
});

test("does not capture declaration defaults over a customized field view", async ({ root }) => {
  const Model = staticModel({
    data: { count: f.number(0) },
    setup(self) {
      Object.setPrototypeOf(
        self.count,
        Object.create(Object.getPrototypeOf(self.count), {
          value: { get: () => 17, configurable: true },
        }),
      );
    },
  });
  const View = component({ model: Model, view: (props) => h("p", null, props.count) });
  await root.render(() => h(View, { id: "custom" }));
  expect(root.container.textContent).toBe("17");
});

test("discovers live DOM bindings when inspection starts after rendering", async ({ root }) => {
  const before = new Set(getInspectorSnapshot().nodes.map((entry) => entry.id));
  const text = store(0),
    title = store("first");
  await root.render(() => h("p", { title }, text));
  const element = root.container.firstElementChild!;
  const bindings = getInspectorSnapshot().nodes.filter(
    (entry) => !before.has(entry.id) && entry.meta.description === "DOM binding",
  );
  expect(bindings).toHaveLength(2);
  expect(getInspectorSnapshot().nodes.some((entry) => entry.type === "ui.root")).toBe(false);
  root.run(() => {
    text.value = 1;
    title.value = "second";
  });
  expect(root.container.firstElementChild).toBe(element);
  expect(element.textContent).toBe("1");
  expect(element.getAttribute("title")).toBe("second");
});

test("reports DOM nodes immediately when inspection is enabled", async ({ root }) => {
  const text = store(0);
  let created = 0;
  const stop = onInspectorEvent((event) => {
    if (
      event.type === "node-created" &&
      readInspectorNodeMeta(event.node).description === "DOM binding"
    )
      created++;
  });
  try {
    await root.render(() => h("p", null, text));
  } finally {
    stop();
  }
  expect(created).toBe(1);
});

test("discovers new native bindings after an earlier late snapshot", async ({ root }) => {
  const shown = store(true), value = store("first");
  await root.render(() => h("main", null, () => shown.value ? h("b", null, value) : null));
  const first = new Set(getInspectorSnapshot().nodes.map((entry) => entry.id));
  root.run(() => { shown.value = false; });
  root.run(() => { shown.value = true; });
  const next = getInspectorSnapshot().nodes.filter(
    (entry) => !first.has(entry.id) && entry.meta.description === "DOM binding",
  );
  expect(next).toHaveLength(1);
  const text = root.container.querySelector("b")!.firstChild;
  root.run(() => { value.value = "second"; });
  expect(text!.textContent).toBe("second");
  expect(root.container.querySelector("b")!.firstChild).toBe(text);
});

test("does not discover native bindings rolled back before late inspection", async ({ root }) => {
  const value = store("first");
  const before = new Set(getInspectorSnapshot().nodes.map((entry) => entry.id));
  await expect(root.render(() => [h("b", null, value), h("i", {
    get children() { throw Error("failed attachment"); },
  })])).rejects.toThrow("failed attachment");
  expect(root.container.childNodes).toHaveLength(0);
  expect(getInspectorSnapshot().nodes.filter(
    (entry) => !before.has(entry.id) && entry.meta.description === "DOM binding",
  )).toHaveLength(0);
});

test("keeps text bindings usable when an inspector freezes the registered node", async ({
  root,
}) => {
  const text = store(0);
  const stop = onInspectorEvent((event) => {
    if (
      event.type === "node-created" &&
      readInspectorNodeMeta(event.node).description === "DOM binding"
    )
      Object.freeze(event.node);
  });
  try {
    await root.render(() => h("p", null, text));
  } finally {
    stop();
  }
  const node = root.container.querySelector("p")!.firstChild;
  root.run(() => {
    text.value = 1;
  });
  expect(root.container.textContent).toBe("1");
  expect(root.container.querySelector("p")!.firstChild).toBe(node);
});

test("does not allocate graph nodes for static DOM properties and children", async ({ root }) => {
  const before = new Set(getInspectorSnapshot().nodes.map((node) => node.id));
  await root.render(() =>
    h(
      "main",
      null,
      Array.from({ length: 100 }, (_, id) =>
        h(
          "p",
          { title: "static", class: "row", style: { color: "red" }, "data-id": id },
          String(id),
        ),
      ),
    ),
  );
  expect(root.container.querySelectorAll("p")).toHaveLength(100);
  expect(getInspectorSnapshot().nodes.filter((node) => !before.has(node.id))).toEqual([]);
});

test("observes each staticModel row directly without a subscriber per row", async ({ root }) => {
  let count!: Pick<ReturnType<typeof store<number>>, "subscribe">;
  const Model = staticModel({
    data: { count: f.number(0) },
    setup(self) {
      count = self.count;
    },
  });
  const subscribe = vi.spyOn(count, "subscribe");
  const view = vi.fn();
  const Row = component({
    model: Model,
    view(_props, self) {
      view();
      return h("p", { "data-id": self.id }, self.model.count);
    },
  });
  await root.render(() =>
    h(
      "main",
      null,
      Array.from({ length: 100 }, (_, id) => h(Row, { id: String(id) })),
    ),
  );
  // One collection/index feed for the definition, not 100 filtered callbacks.
  expect(subscribe).toHaveBeenCalledTimes(1);
  const rows = [...root.container.querySelectorAll("p")];
  root.run(() => {
    Model.get("0")!.count.value = 1;
  });
  expect(root.container.querySelectorAll("p")[0]).toBe(rows[0]);
  expect(rows.map((row) => row.textContent)).toEqual(["1", ...Array(99).fill("0")]);
  expect(view).toHaveBeenCalledTimes(100);
  subscribe.mockRestore();
});

test("captures component constructor props once and reuses their reactive dependencies", async ({
  root,
}) => {
  const source = store("first");
  const read = vi.fn(() => source.value);
  const view = vi.fn();
  const Row = component({
    model: staticModel({ data: { title: f.string("") } }),
    view(_props, self) {
      view();
      return h("p", null, self.model.title);
    },
  });
  await root.render(() =>
    h(Row, {
      id: "row",
      get title() {
        return read();
      },
    }),
  );
  const element = root.container.querySelector("p");
  expect(read).toHaveBeenCalledTimes(1);
  expect(element!.textContent).toBe("first");
  root.run(() => {
    source.value = "second";
  });
  expect(read).toHaveBeenCalledTimes(2);
  expect(root.container.querySelector("p")).toBe(element);
  expect(element!.textContent).toBe("second");
  expect(view).toHaveBeenCalledTimes(1);
});

test("reads a dynamic property once initially and switches only its dependencies", async ({
  root,
}) => {
  const left = store("left"),
    right = store("right"),
    chooseLeft = store(true);
  const read = vi.fn(() => (chooseLeft.value ? left.value : right.value));
  await root.render(() => h("p", { title: read }, "stable"));
  const element = root.container.querySelector("p")!;
  expect(read).toHaveBeenCalledTimes(1);
  root.run(() => {
    chooseLeft.value = false;
  });
  expect(element.title).toBe("right");
  expect(read).toHaveBeenCalledTimes(2);
  root.run(() => {
    left.value = "inactive";
  });
  expect(read).toHaveBeenCalledTimes(2);
  root.run(() => {
    right.value = "active";
  });
  expect(element.title).toBe("active");
  expect(root.container.querySelector("p")).toBe(element);
});

test("does not subscribe DOM properties to reads inside a called effect", async ({ root }) => {
  const title = store("first"),
    hidden = store(0);
  const readHidden = effect(() => hidden.value);
  const read = vi.fn(() => {
    void readHidden();
    return title.value;
  });
  await root.render(() => h("p", { title: read }));
  expect(read).toHaveBeenCalledTimes(1);
  root.run(() => {
    hidden.value++;
  });
  expect(read).toHaveBeenCalledTimes(1);
  root.run(() => {
    title.value = "next";
  });
  expect(read).toHaveBeenCalledTimes(2);
  expect(root.container.querySelector("p")!.title).toBe("next");
});

test("reads each native scalar text once at mount and detaches both independent bindings", async ({
  root,
}) => {
  const Model = staticModel({ data: { count: f.number(0) } });
  const instance = root.run(() => Model.create({ id: "shared", count: 2 }));
  const field = instance.count;
  const read = vi.spyOn(field, "value", "get");
  const View = component({
    model: Model,
    view: () => h("main", null, h("p", null, field), h("p", null, field)),
  });
  await root.render(() => h(View, { model: instance }));
  expect(read).toHaveBeenCalledTimes(2);
  const texts = [...root.container.querySelectorAll("p")].map((row) => row.firstChild!);
  field.value = 3;
  expect(texts.map((text) => text.textContent)).toEqual(["3", "3"]);
  expect([...root.container.querySelectorAll("p")].map((row) => row.firstChild)).toEqual(texts);
  await root.render(() => null);
  const calls = read.mock.calls.length;
  field.value = 4;
  expect(read).toHaveBeenCalledTimes(calls);
  expect(texts.map((text) => text.textContent)).toEqual(["3", "3"]);
  read.mockRestore();
});

test("keeps dependency discovery for custom writable scalar sources", async ({ root }) => {
  const value = store("first");
  const read = vi.fn(() => value.value);
  const source = {
    node: value.node,
    writable: true as const,
    get value() {
      return read();
    },
  };
  await root.render(() => h("p", null, source));
  // Unknown custom units retain the discovery read after the scalar probe.
  expect(read).toHaveBeenCalledTimes(2);
  const text = root.container.querySelector("p")!.firstChild;
  root.run(() => {
    value.value = "second";
  });
  expect(read).toHaveBeenCalledTimes(3);
  expect(root.container.querySelector("p")!.firstChild).toBe(text);
  expect(text!.textContent).toBe("second");
});

test("keeps an initially structural native unit structural across replacements", async ({
  root,
}) => {
  const value = store<Child>([h("i", null, "first")]);
  await root.render(() => h("section", null, value));
  const section = root.container.querySelector("section")!;
  root.run(() => {
    value.value = [h("b", null, "second"), h("b", null, "third")];
  });
  expect(root.container.querySelector("section")).toBe(section);
  expect(section.querySelectorAll("b")).toHaveLength(2);
  root.run(() => {
    value.value = "scalar";
  });
  expect(root.container.querySelector("section")).toBe(section);
  expect(section.textContent).toBe("scalar");
});

test("keeps shared prop handlers readonly and preserves plain-object reflection", async ({
  root,
}) => {
  const Model = staticModel({ data: { title: f.string("default") } });
  const received: object[] = [];
  const View = component({
    model: Model,
    view(props) {
      received.push(props);
      return h("p", null, props.title);
    },
  });
  await root.render(() => [h(View, { id: "a" }), h(View, { id: "b", title: "other" })]);
  expect(Object.getPrototypeOf(received[0])).toBe(Object.prototype);
  expect(Object.keys(received[0]).sort()).toEqual(["id", "title"]);
  expect(() => Reflect.set(received[0], "title", "no")).toThrow("read-only");
  Object.preventExtensions(received[0]);
  expect(Object.getPrototypeOf(received[0])).toBe(Object.prototype);
  expect(Reflect.get(received[0], "title")).toBe("default");
  Object.setPrototypeOf(received[1], null);
  expect(Object.getPrototypeOf(received[1])).toBeNull();
  Object.preventExtensions(received[1]);
  expect(Object.getPrototypeOf(received[1])).toBeNull();
  expect(Reflect.get(received[1], "title")).toBe("other");
});

test("preserves an instance's customized json method when capturing view props", async ({
  root,
}) => {
  const Model = staticModel({ data: { count: f.number(0) } });
  const row = root.run(() => Model.create({ id: "row" }));
  const json = vi.spyOn(row, "json").mockReturnValue({ id: "row", count: 7 });
  const View = component({ model: Model, view: (props) => h("p", null, props.count) });
  await root.render(() => h(View, { model: row }));
  expect(json).toHaveBeenCalledTimes(1);
  expect(root.container.textContent).toBe("7");
  json.mockRestore();
});

test("captures default props at attachment even when first read happens after model disposal", async ({
  root,
}) => {
  const Model = staticModel({ data: { count: f.number(0) } });
  const row = root.run(() => Model.create({ id: "before" }));
  let received!: object;
  const View = component({
    model: Model,
    view(props) {
      received = props;
      return h("p", null, "not reading props");
    },
  });
  await root.render(() => h(View, { model: row }));
  row.count.value = 9;
  row.rebind("after");
  await root.render(() => null);
  await row.dispose();
  expect({ ...received }).toEqual({ id: "before", count: 0 });
});

test("preserves an unread model input snapshot across remounts", async ({ root }) => {
  const Model = staticModel({ data: { count: f.number(0) } });
  const row = root.run(() => Model.create({ id: "row" }));
  const received: unknown[] = [];
  const View = component({
    model: Model,
    view(props) {
      received.push(props);
      return null;
    },
  });
  await root.render(() => h(View, { model: row }));
  await root.render(() => null);
  row.count.value = 3;
  await root.render(() => h(View, { model: row }));
  // Component props belong to the model. A retained model reuses its input
  // snapshot; model fields remain the source of its current reactive state.
  expect(received[1]).toBe(received[0]);
  expect({ ...(received[0] as object) }).toEqual({ id: "row", count: 0 });
  expect(row.count.value).toBe(3);
});

test("still calls custom json at mount when view never reads props", async ({ root }) => {
  const Model = staticModel({ data: { count: f.number(0) } });
  const row = root.run(() => Model.create({ id: "row" }));
  const json = vi.spyOn(row, "json").mockReturnValue({ id: "row", count: 7 });
  const View = component({ model: Model, view: () => null });
  await root.render(() => h(View, { model: row }));
  expect(json).toHaveBeenCalledTimes(1);
  json.mockRestore();
});

test("releases an auto model when its customized props snapshot throws", async ({ root }) => {
  const Model = staticModel({
    data: { count: f.number(0) },
    onCreate(self) {
      Object.defineProperty(self, "json", {
        configurable: true,
        value() {
          throw Error("snapshot failed");
        },
      });
    },
  });
  const View = component({ model: Model, keep: true, view: () => null });
  await expect(root.render(() => h(View, { id: "failed" }))).rejects.toThrow("snapshot failed");
  expect(root.run(() => Model.get("failed"))).toBeNull();
  expect(root.container.childNodes).toHaveLength(0);
});

test("rolls back provisional models when keep evaluation fails before view", async ({ root }) => {
  const Model = staticModel({ data: { count: f.number(0) } });
  const View = component({ model: Model, view: () => null });
  await expect(
    root.render(() =>
      h(View, {
        id: "failed",
        get keep(): boolean {
          throw Error("keep failed");
        },
      }),
    ),
  ).rejects.toThrow("keep failed");
  expect(root.run(() => Model.get("failed"))).toBeNull();
  expect(root.container.childNodes).toHaveLength(0);
});

test("automatic unmount still invokes a customized public model dispose", async ({ root }) => {
  const calls: string[] = [];
  const Model = staticModel({
    data: { count: f.number(0) },
    onCreate(self) {
      const dispose = self.dispose;
      Object.defineProperty(self, "dispose", {
        configurable: true,
        value() {
          calls.push(self.id);
          return dispose();
        },
      });
    },
  });
  const View = component({ model: Model, view: () => null });
  await root.render(() => h(View, { id: "custom" }));
  await root.render(() => null);
  expect(calls).toEqual(["custom"]);
  expect(root.run(() => Model.get("custom"))).toBeNull();
});

test("scalar array leaves preserve sibling identities, namespaces and independent bindings", async ({
  root,
}) => {
  const count = store(1);
  const Model = staticModel({ name: "ScalarSibling" });
  const ids: string[] = [];
  const Child = component({
    model: Model,
    view(_props, self) {
      ids.push(self.elementId("node"));
      return h("b", { id: self.elementId("node") }, self.id);
    },
  });
  await root.render(() =>
    h("main", null, [
      h("span", null, "static"),
      h("span", null, false),
      h("span", null, count),
      h(Child, { id: "child" }),
      h("svg", null, [h("text", null, "svg"), h("text", null, count)]),
    ]),
  );
  const first = root.container.querySelector("span")!;
  const text = root.container.querySelectorAll("span")[2]!.firstChild;
  const svgText = root.container.querySelectorAll("text")[1]!.firstChild;
  expect(ids).toEqual(["ui:test:ScalarSibling:child:node"]);
  expect(root.container.querySelector("text")!.namespaceURI).toBe("http://www.w3.org/2000/svg");
  root.run(() => {
    count.value = 2;
  });
  expect(root.container.querySelector("span")).toBe(first);
  expect(root.container.querySelectorAll("span")[2]!.firstChild).toBe(text);
  expect(text!.textContent).toBe("2");
  expect(svgText!.textContent).toBe("2");
  await root.render(() => null);
  const removedValue = text!.textContent;
  root.run(() => {
    count.value = 3;
  });
  expect(text!.textContent).toBe(removedValue);
});
