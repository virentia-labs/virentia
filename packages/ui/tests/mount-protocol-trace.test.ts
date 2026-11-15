import { reaction, scope, store } from "@virentia/core";
import { f, staticModel } from "@virentia/core/models";
import { expect, vi } from "vitest";
import { component, hydrate, ref, render, ui } from "../lib";
import { jsx } from "../lib/jsx-runtime";
import { renderToString } from "../lib/server";
import { test } from "./support/vitest";

test("orders sibling native reads before mounted while keeping refs through unmounted", async ({ root }) => {
  const trace: string[] = [];
  const Model = staticModel({
    with: [ui],
    data: { count: f.number(1) },
    setup(self) {
      const target = ref<HTMLElement>();
      reaction({ on: self.mounted, run() {
        trace.push(`${self.id}:mounted:${target.value!.textContent}:${root.container.childElementCount}`);
      } });
      reaction({ on: self.unmounted, run() {
        trace.push(`${self.id}:unmounted:${target.value!.isConnected}`);
      } });
      return { target };
    },
  });
  const View = component({ model: Model, view(_props, self) {
    return jsx("section", {
      get title() {
        trace.push(`${self.id}:title:${root.container.childElementCount}`);
        return self.id;
      },
      ref: self.model.target,
      get children() {
        trace.push(`${self.id}:children`);
        return self.model.count;
      },
    });
  } });
  const [a, b] = root.run(() => [Model.create({ id: "a" }), Model.create({ id: "b" })]);
  await root.render(() => [jsx(View, { model: a }), jsx(View, { model: b })]);
  expect(trace).toEqual([
    "a:title:0", "a:children", "b:title:0", "b:children",
    "a:mounted:1:2", "b:mounted:1:2",
  ]);
  await root.render(() => null);
  expect(trace.slice(6)).toEqual(["a:unmounted:true", "b:unmounted:true"]);
  expect([a.target.value, b.target.value]).toEqual([null, null]);
  expect([a.alive, b.alive]).toEqual([true, true]);
});

test("disposes a moved hydrated binding before reusing the supplied model", async ({ root }) => {
  const Model = staticModel({
    data: { count: f.number(1) },
    setup() { return { target: ref<HTMLElement>() }; },
  });
  const View = component({ model: Model, view: (_props, self) =>
    jsx("p", { ref: self.model.target, children: self.model.count }),
  });
  root.container.innerHTML = renderToString(() => jsx(View, { id: "row" }), {
    scope: scope(), identifierPrefix: "test",
  });
  const paragraph = root.container.firstElementChild!;
  const originalText = [...paragraph.childNodes].find((node) => node.nodeType === 3)!;
  const instance = root.run(() => Model.create({ id: "row" }));
  const detach = hydrate(() => jsx(View, { model: instance }), root.container, {
    scope: root.scope, identifierPrefix: "test",
  });
  try {
    expect(instance.target.value).toBe(paragraph);
    expect([...paragraph.childNodes]).toContain(originalText);
    const external = root.document.createElement("aside");
    external.appendChild(originalText);
    instance.count.value = 2;
    expect(originalText.textContent).toBe("2");
    await detach();
    expect(external.childNodes).toHaveLength(0);
    expect(instance.target.value).toBeNull();
    expect(instance.alive).toBe(true);
    await root.render(() => jsx(View, { model: instance }));
    const replacement = root.container.querySelector("p")!;
    expect(replacement).not.toBe(paragraph);
    expect(replacement.textContent).toBe("2");
    instance.count.value = 3;
    expect(replacement.textContent).toBe("3");
    expect(originalText.textContent).toBe("2");
  } finally {
    await detach();
  }
});

test("keeps property dependencies after a DOM callback mounts another reactive property", async ({ root }) => {
  const title = store("outer"), tail = store("tail"), nestedTitle = store("nested");
  const nested = root.document.createElement("aside");
  let detachNested: ReturnType<typeof render> | undefined;
  const reads = { title: 0, tail: 0, nested: 0 };
  const createElement = root.document.createElement.bind(root.document);
  const spy = vi.spyOn(root.document, "createElement").mockImplementation((tag, options) => {
    const element = createElement(tag, options);
    if (tag === "p") {
      const setAttribute = element.setAttribute.bind(element);
      element.setAttribute = (name, value) => {
        setAttribute(name, value);
        if (name === "title" && !detachNested) {
          detachNested = render(() => jsx("span", {
            get title() { reads.nested++; return nestedTitle.value; },
          }), nested, { scope: root.scope });
        }
      };
    }
    return element;
  });
  try {
    await root.render(() => jsx("p", {
      get title() { reads.title++; return title.value; },
      get "data-tail"() { reads.tail++; return tail.value; },
    }));
    const paragraph = root.container.querySelector("p")!;
    const span = nested.querySelector("span")!;
    expect(reads).toEqual({ title: 1, tail: 1, nested: 1 });
    root.run(() => { nestedTitle.value = "nested next"; });
    expect([paragraph.title, span.title]).toEqual(["outer", "nested next"]);
    expect(reads).toEqual({ title: 1, tail: 1, nested: 2 });
    root.run(() => { title.value = "outer next"; });
    root.run(() => { tail.value = "tail next"; });
    expect([paragraph.title, paragraph.getAttribute("data-tail"), span.title]).toEqual([
      "outer next", "tail next", "nested next",
    ]);
    expect(reads).toEqual({ title: 2, tail: 2, nested: 2 });
  } finally {
    spy.mockRestore();
    await detachNested?.();
  }
});
