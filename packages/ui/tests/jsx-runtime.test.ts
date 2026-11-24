import { store } from "@virentia/core";
import { f, staticModel } from "@virentia/core/models";
import { expect } from "vitest";
import { component, h, mergeProps } from "../lib";
import { jsx } from "../lib/jsx-runtime";
import { renderToString } from "../lib/server";
import { scope } from "@virentia/core";
import { test } from "./support/vitest";

test("h distinguishes omitted, explicit undefined and multiple children", () => {
  const source = { children: "source", title: "title" };
  expect(h.length).toBe(2);
  expect(h("p").props).toEqual({});
  expect(h("p", source).props).toBe(source);
  expect(h("p", source, undefined).props.children).toBeUndefined();
  expect(Object.hasOwn(h("p", null, undefined).props, "children")).toBe(true);
  const children = ["a", undefined, "b", false, 7n];
  expect(h("p", null, ...children).props.children).toEqual(children);
  expect(h("p", source, ...children).props.children).toEqual(children);
  expect(h((props) => props.children as string, source, ...children).props.children)
    .toEqual(children);
  expect(source.children).toBe("source");
});

test("unkeyed JSX preserves live props without inspecting them during description creation", async ({ root }) => {
  const reads: PropertyKey[] = [];
  const text = store("first");
  const source = new Proxy({ children: text }, {
    ownKeys(target) { reads.push("keys"); return Reflect.ownKeys(target); },
    get(target, key, receiver) { reads.push(key); return Reflect.get(target, key, receiver); },
  });
  const description = jsx("p", source);
  expect(description.props).toBe(source);
  expect(Object.keys(description)).toEqual(["type", "props"]);
  expect(reads).toEqual([]);
  await root.render(() => description);
  const node = root.container.firstElementChild!.firstChild;
  root.run(() => { text.value = "next"; });
  expect(root.container.firstElementChild!.firstChild).toBe(node);
  expect(root.container.textContent).toBe("next");
});

test("overlays JSX metadata without snapshotting source getters or reading an overridden key", () => {
  let title = "first";
  const token = Symbol("source");
  const key = Symbol("jsx key");
  const source = {
    get key() {
      throw Error("the source key must remain unread");
    },
    get title() {
      return title;
    },
    [token]: "token",
  };
  const element = jsx("div", source, key);
  const props = element.props;
  expect(Object.keys(element)).toEqual(["type", "props"]);
  expect(Reflect.ownKeys(props)).toEqual(["key", "title", token]);
  expect(props.key).toBe(key);
  expect(props.title).toBe("first");
  title = "second";
  expect(element.props).toBe(props);
  expect(props.title).toBe("second");
  expect(props[token as never]).toBe("token");
});

test("does not expose inherited constructor inputs through keyed JSX", async ({ root }) => {
  const Model = staticModel({ data: { count: f.number(0) } });
  const View = component({
    model: Model,
    view: (_props, self) => h("span", null, self.model.count),
  });
  const source = Object.assign(
    Object.create({
      get model() {
        throw Error("inherited model");
      },
      id: "inherited",
      keep: true,
    }),
    { count: 7 },
  );
  await root.render(() => jsx(View, source, "metadata"));
  const instance = root.run(() => Model.instances.first)!;
  expect(instance.id).not.toBe("inherited");
  expect(root.container.textContent).toBe("7");
  await root.render(() => null);
  expect(root.run(() => Model.instances.count)).toBe(0);
});

test("still passes an overridden key to ordinary view helpers", async ({ root }) => {
  const source = Object.freeze({ key: "source" });
  await root.render(() => jsx((props) => h("span", null, String(props.key)), source, "jsx"));
  expect(root.container.textContent).toBe("jsx");
  expect(source.key).toBe("source");
});

test("keyed model selectors switch instances without inheriting display options", async ({
  root,
}) => {
  const Model = staticModel({ data: { count: f.number(0) } });
  const [first, second] = root.run(() => [
    Model.create({ id: "a", count: 1 }),
    Model.create({ id: "b", count: 2 }),
  ]);
  const selected = store<typeof first | null>(first);
  const View = component({
    model: Model,
    view: (_props, self) => h("span", null, self.model.count),
  });
  const source = Object.assign(Object.create({ id: "inherited", keep: true }), { model: selected });
  await root.render(() => jsx(View, source, "metadata"));
  expect(root.container.textContent).toBe("1");
  root.run(() => {
    selected.value = second;
  });
  expect(root.container.textContent).toBe("2");
  root.run(() => {
    selected.value = null;
  });
  expect(root.container.textContent).toBe("");
  expect(first.alive).toBe(true);
  expect(second.alive).toBe(true);
});

test("captures own constructor getters once and honours explicit keep overrides", async ({
  root,
}) => {
  let ids = 0,
    counts = 0,
    keeps = 0;
  const Model = staticModel({ data: { count: f.number(0) } });
  const View = component({
    model: Model,
    keep: true,
    view: (_props, self) => h("span", null, self.model.count),
  });
  await root.render(() =>
    jsx(
      View,
      {
        get id() {
          ids++;
          return "row";
        },
        get count() {
          counts++;
          return 3;
        },
        get keep() {
          keeps++;
          return false;
        },
      },
      "metadata",
    ),
  );
  expect({ ids, counts, keeps }).toEqual({ ids: 2, counts: 1, keeps: 2 });
  expect(root.container.textContent).toBe("3");
  await root.render(() => null);
  expect(root.run(() => Model.get("row"))).toBeNull();
});

test("keeps reactive spread shapes and native text bindings live through JSX metadata", async ({
  root,
}) => {
  const text = store("first");
  const attributes = store<Record<string, unknown>>({
    title: "first",
    disabled: true,
    children: text,
  });
  const element = jsx(
    "button",
    mergeProps(() => attributes.value),
    "metadata",
  );
  await root.render(() => element);
  const button = root.container.querySelector("button")!;
  const node = button.firstChild;
  root.run(() => {
    attributes.value = { title: "second", "data-added": "yes", children: text };
    text.value = "second";
  });
  expect(root.container.querySelector("button")).toBe(button);
  expect(button.firstChild).toBe(node);
  expect(button.textContent).toBe("second");
  expect(button.title).toBe("second");
  expect(button.disabled).toBe(false);
  expect(button.getAttribute("data-added")).toBe("yes");
  expect(button.hasAttribute("key")).toBe(false);
  expect(element.props.key).toBe("metadata");
});

test("preserves plain-object prototype reflection after preventing extensions", () => {
  const props = jsx("div", { title: "first" }, "metadata").props;
  expect(Object.getPrototypeOf(props)).toBe(Object.prototype);
  Object.preventExtensions(props);
  expect(Object.getPrototypeOf(props)).toBe(Object.prototype);
  expect(props.title).toBe("first");
  expect(props.key).toBe("metadata");
  const other = jsx("div", { title: "other" }, 2).props;
  Object.setPrototypeOf(other, null);
  Object.preventExtensions(other);
  expect(Object.getPrototypeOf(other)).toBeNull();
  expect(other.title).toBe("other");
});

test("hydrates keyed JSX and updates its original text node in place", async ({ root }) => {
  const Model = staticModel({ name: "KeyedJSXCounter", data: { count: f.number(0) } });
  const View = component({
    model: Model,
    view: (_props, self) => jsx("span", { children: self.model.count }, "text"),
  });
  const view = () => jsx(View, { id: "row" }, "component");
  const html = renderToString(view, { scope: scope(), identifierPrefix: "test" });
  await root.hydrate(view, html);
  const span = root.container.querySelector("span")!;
  const node = [...span.childNodes].find((child) => child.nodeType === 3);
  root.run(() => {
    Model.get("row")!.count.value = 4;
  });
  expect(root.container.querySelector("span")).toBe(span);
  expect([...span.childNodes]).toContain(node);
  expect(span.textContent).toBe("4");
});
