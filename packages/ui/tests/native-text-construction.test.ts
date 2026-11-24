import { store } from "@virentia/core";
import { expect } from "vitest";
import { h } from "../lib";
import { jsx } from "../lib/jsx-runtime";
import { test } from "./support/vitest";

test("keeps an empty native Text node and updates it in place", async ({ root }) => {
  const text = store<string | null>("");
  await root.render(() => h("p", null, text));
  const paragraph = root.container.firstChild!;
  const node = paragraph.firstChild!;
  expect(node.nodeType).toBe(3);
  expect(node.textContent).toBe("");
  for (const value of ["ready", "", null, "again"]) {
    root.run(() => {
      text.value = value;
    });
    expect(paragraph.firstChild).toBe(node);
    expect(node.textContent).toBe(value ?? "");
  }
});

for (const mode of ["h", "jsx"] as const) {
  test(`owns moved scalar leaf text (${mode})`, async ({ root }) => {
    await root.render(() => mode === "h"
      ? h("main", null, [h("p", null, "a"), h("p", null, "")])
      : jsx("main", { children: [jsx("p", { children: "a" }), jsx("p", { children: "" })] }));
    const leaves = [...root.container.querySelectorAll("p")];
    const external = root.document.createElement("aside");
    for (const leaf of leaves) {
      expect(leaf.firstChild!.nodeType).toBe(3);
      external.appendChild(leaf.firstChild!);
    }
    expect(external.childNodes).toHaveLength(2);
    await root.render(() => null);
    expect(external.childNodes).toHaveLength(0);
  });
}

test("preserves reactive Text identity in SVG with ordinary JSX descriptions", async ({ root }) => {
  const text = store("first");
  await root.render(() => jsx("svg", { children: jsx("text", { children: text }) }));
  const element = root.container.querySelector("text")!;
  const node = element.firstChild;
  expect(element.namespaceURI).toBe("http://www.w3.org/2000/svg");
  root.run(() => {
    text.value = "second";
  });
  expect(element.firstChild).toBe(node);
  expect(element.textContent).toBe("second");
});

test("a function child patches its text in place and still switches content", async ({ root }) => {
  const value = store<string | number | null | { tag: string }>("a");
  await root.render(() =>
    h("p", null, () => {
      const current = value.value;
      return current !== null && typeof current === "object" ? h(current.tag, null, "x") : current;
    }),
  );
  const paragraph = root.container.querySelector("p")!;
  const node = [...paragraph.childNodes].find((child) => child.nodeType === 3)!;
  expect(node.textContent).toBe("a");
  root.run(() => { value.value = 2; });
  expect([...paragraph.childNodes].find((child) => child.nodeType === 3)).toBe(node);
  expect(paragraph.textContent).toBe("2");
  root.run(() => { value.value = null; });
  expect(paragraph.textContent).toBe("");
  expect(node.isConnected).toBe(false);
  root.run(() => { value.value = { tag: "b" }; });
  expect(paragraph.querySelector("b")!.textContent).toBe("x");
  root.run(() => { value.value = "c"; });
  expect(paragraph.querySelector("b")).toBeNull();
  expect(paragraph.textContent).toBe("c");
});
