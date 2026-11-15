import { store } from "@virentia/core";
import { expect, vi } from "vitest";
import { test } from "./support/vitest";
import { action, h, mergeProps, ref } from "../lib";

test("changes one property without churning refs, listeners or unrelated reads", async ({ root }) => {
  const name = store("first");
  const reads = { title: 0, ref: 0, style: 0 };
  const input = ref<HTMLButtonElement>();
  const clicked = vi.fn();
  const click = action(clicked);
  await root.render(() => h("button", {
    class: name, onClick: click,
    get title() { reads.title++; return "stable"; },
    get ref() { reads.ref++; return input; },
    get style() { reads.style++; return { color: "red" }; },
  }));
  const button = root.container.querySelector("button")!;
  const add = vi.spyOn(button, "addEventListener"), remove = vi.spyOn(button, "removeEventListener");
  root.run(() => { name.value = "second"; });
  expect(button.className).toBe("second");
  expect(reads).toEqual({ title: 1, ref: 1, style: 1 });
  expect(root.run(() => input.value)).toBe(button);
  button.click();
  expect(clicked).toHaveBeenCalledTimes(1);
  expect(add).not.toHaveBeenCalled();
  expect(remove).not.toHaveBeenCalled();
  await root.render(() => null);
  expect(root.run(() => input.value)).toBeNull();
  // The listener leaves with its element, inert.
  expect(remove).not.toHaveBeenCalled();
  button.click();
  expect(clicked).toHaveBeenCalledTimes(1);
});
test("adds and removes live spread props and event units on the same element", async ({ root }) => {
  const clicked = vi.fn();
  const click = action(clicked);
  const props = store<Record<string, unknown> | null>({ title: "first", disabled: true, style: { color: "red" } });
  await root.render(() => h("button", mergeProps(() => props.value)));
  const button = root.container.querySelector("button")!;
  root.run(() => { props.value = { title: "second", "data-added": "yes", onClick: click }; });
  expect(root.container.querySelector("button")).toBe(button);
  expect(button.title).toBe("second");
  expect(button.disabled).toBe(false);
  expect(button.style.color).toBe("");
  button.click();
  expect(clicked).toHaveBeenCalledTimes(1);
  root.run(() => { props.value = null; });
  expect(button.hasAttribute("title")).toBe(false);
  button.click();
  expect(clicked).toHaveBeenCalledTimes(1);
});
test("removes a conditional property's subscription before reading an invalid getter", async ({ root }) => {
  const state = store<{ title: string } | null>({ title: "safe" });
  const props = new Proxy({}, {
    ownKeys: () => state.value ? ["title"] : [],
    getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
    get: (_target, key) => key === "title" ? state.value!.title : undefined,
  });
  await root.render(() => h("div", props));
  const element = root.container.querySelector("div")!;
  root.run(() => { state.value = null; });
  expect(element.hasAttribute("title")).toBe(false);
});
test("combines class aliases and token maps deterministically", async ({ root }) => {
  const base = store("base removable");
  const tokens = store({ extra: true, removable: false });
  await root.render(() => h("div", { class: "ignored", className: base, classList: tokens }));
  const element = root.container.querySelector("div")!;
  expect(new Set(element.classList)).toEqual(new Set(["base", "extra"]));
  root.run(() => { base.value = "next removable"; tokens.value = { extra: false, removable: true }; });
  expect(new Set(element.classList)).toEqual(new Set(["next", "removable"]));
});
test("snapshots style maps so an in-place value update can remove old declarations", async ({ root }) => {
  const changed = store(0);
  const style: Record<string, string> = { color: "red", backgroundColor: "black" };
  await root.render(() => h("div", { get style() { void changed.value; return style; } }));
  const element = root.container.querySelector("div")!;
  style.color = "blue"; delete style.backgroundColor;
  root.run(() => { changed.value++; });
  expect(element.style.color).toBe("blue");
  expect(element.style.backgroundColor).toBe("");
});

test("reads JSX children after installing independent attribute bindings, exactly once", async ({ root }) => {
  const title = store("before");
  const order: string[] = [];
  const Content = () => h("p", {
    get title() { order.push("title"); return title.value; },
    get children() {
      order.push("children");
      title.value = "after";
      return "content";
    },
  });
  await root.render(() => h(Content));
  expect(order).toEqual(["title", "children", "title"]);
  const element = root.container.querySelector("p")!;
  expect(element.title).toBe("after");
  expect(element.textContent).toBe("content");
  root.run(() => { title.value = "last"; });
  expect(element.title).toBe("last");
  expect(order).toEqual(["title", "children", "title", "title"]);
});
test("a static handler leaves with its element: inert, without a removal", async ({ root }) => {
  const clicked = vi.fn();
  const click = action(clicked);
  await root.render(() => h("section", null, h("button", { onClick: click }, "go")));
  const button = root.container.querySelector("button")!;
  const remove = vi.spyOn(button, "removeEventListener");
  button.click();
  expect(clicked).toHaveBeenCalledTimes(1);
  await root.render(() => null);
  expect(button.isConnected).toBe(false);
  expect(remove).not.toHaveBeenCalled();
  // An element someone kept no longer reaches the handler.
  button.click();
  expect(clicked).toHaveBeenCalledTimes(1);
});
