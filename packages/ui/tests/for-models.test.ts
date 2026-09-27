// @vitest-environment happy-dom

import { scope, scoped, store, type Scope } from "@virentia/core";
import { collection, f, staticModel, type InstanceOf } from "@virentia/core/models";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement as h, For, hydrate, render } from "../lib";
import { onMount } from "../lib/runtime";
import { renderToString } from "../lib/server";

const disposers: Array<() => void> = [];

afterEach(() => {
  for (const dispose of disposers.splice(0).reverse()) dispose();
  document.body.textContent = "";
});

function container(html = ""): HTMLDivElement {
  const root = document.createElement("div");
  root.innerHTML = html;
  document.body.append(root);
  return root;
}

function attach(view: Parameters<typeof render>[0], target: HTMLDivElement, appScope: Scope): void {
  disposers.push(render(view, target, { scope: appScope }));
}

describe("For over Core models", () => {
  it("accepts a staticModel definition and follows add/remove and field writes in place", () => {
    const Todo = staticModel({ data: { title: f.string() } });
    const appScope = scope();
    const todos = collection(Todo, appScope);
    const target = container();
    const mounts = vi.fn();
    function Row(props: { item: () => InstanceOf<typeof Todo> }) {
      onMount(() => mounts(props.item().id));
      return h("li", { "data-id": props.item().id }, () => props.item().title.value);
    }

    attach(
      () =>
        h(
          "ul",
          null,
          For({
            each: Todo,
            fallback: h("li", { "data-empty": true }, "empty"),
            children: (item) => h(Row, { item }),
          }),
        ),
      target,
      appScope,
    );
    expect(target.textContent).toBe("empty");

    const first = scoped(appScope, () => todos.add({ id: "a", title: "Alpha" }));
    const rowA = target.querySelector('[data-id="a"]');
    expect(rowA?.textContent).toBe("Alpha");
    expect(target.querySelector("[data-empty]")).toBeNull();
    scoped(appScope, () => {
      first.title.value = "Updated";
    });
    expect(target.querySelector('[data-id="a"]')).toBe(rowA);
    expect(rowA?.textContent).toBe("Updated");

    scoped(appScope, () => {
      todos.add({ id: "b", title: "Beta" });
    });
    expect(Array.from(target.querySelectorAll("li"), (row) => row.textContent)).toEqual([
      "Updated",
      "Beta",
    ]);
    expect(mounts.mock.calls).toEqual([["a"], ["b"]]);
    scoped(appScope, () => {
      todos.remove("a");
    });
    expect(target.querySelector('[data-id="a"]')).toBeNull();
    expect(target.querySelector('[data-id="b"]')?.textContent).toBe("Beta");
  });

  it("accepts a collection directly and reacts to membership changes", () => {
    const Todo = staticModel({ data: { title: f.string() } });
    const appScope = scope();
    const todos = collection(Todo, appScope);
    const target = container();
    attach(
      () =>
        For({
          each: todos,
          children: (item) => h("span", { "data-id": item().id }, () => item().title.value),
        }),
      target,
      appScope,
    );

    scoped(appScope, () => {
      todos.add({ id: "a", title: "A" });
      todos.add({ id: "b", title: "B" });
    });
    expect(target.querySelectorAll("span")).toHaveLength(2);
    const rowB = target.querySelector('[data-id="b"]');
    scoped(appScope, () => {
      todos.remove("a");
    });
    expect(target.querySelectorAll("span")).toHaveLength(1);
    expect(target.querySelector('[data-id="b"]')).toBe(rowB);
  });

  it("updates a captured model field without rereading the For item accessor or remounting", () => {
    const Todo = staticModel({ data: { title: f.string() } });
    const appScope = scope();
    const todos = collection(Todo, appScope);
    const model = scoped(appScope, () => todos.add({ id: "a", title: "Alpha" }));
    const target = container();
    const rows = vi.fn();

    attach(
      () =>
        For({
          each: Todo,
          children: (item) => {
            const captured = item();
            rows(captured.id);
            return h("span", { "data-id": captured.id }, () => captured.title.value);
          },
        }),
      target,
      appScope,
    );
    const span = target.querySelector("span")!;
    const text = Array.from(span.childNodes).find((child) => child.nodeType === 3)!;
    expect(span.textContent).toBe("Alpha");

    scoped(appScope, () => {
      model.title.value = "Updated";
    });
    expect(target.querySelector("span")).toBe(span);
    expect(Array.from(span.childNodes)).toContain(text);
    expect(text.textContent).toBe("Updated");
    expect(rows).toHaveBeenCalledTimes(1);
  });

  it("switches direct model-field dependencies and unsubscribes on root disposal", () => {
    const Todo = staticModel({ data: { title: f.string() } });
    const appScope = scope();
    const todos = collection(Todo, appScope);
    const [first, second] = scoped(appScope, () => [
      todos.add({ id: "a", title: "Alpha" }),
      todos.add({ id: "b", title: "Beta" }),
    ]);
    const chooseFirst = store(true);
    const read = vi.fn(() => (chooseFirst.value ? first.title.value : second.title.value));
    const target = container();
    const dispose = render(() => h("p", null, read), target, { scope: appScope });
    disposers.push(dispose);
    const paragraph = target.querySelector("p")!;
    expect(paragraph.textContent).toBe("Alpha");
    expect(read).toHaveBeenCalledTimes(1);

    scoped(appScope, () => {
      second.title.value = "Beta changed";
    });
    expect(read).toHaveBeenCalledTimes(1);
    scoped(appScope, () => {
      chooseFirst.value = false;
    });
    expect(paragraph.textContent).toBe("Beta changed");
    expect(read).toHaveBeenCalledTimes(2);
    scoped(appScope, () => {
      first.title.value = "Alpha changed";
    });
    expect(read).toHaveBeenCalledTimes(2);
    scoped(appScope, () => {
      second.title.value = "Final";
    });
    expect(target.querySelector("p")).toBe(paragraph);
    expect(paragraph.textContent).toBe("Final");
    expect(read).toHaveBeenCalledTimes(3);

    dispose();
    scoped(appScope, () => {
      second.title.value = "After dispose";
    });
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("reorders a sorted collection query without remounting keyed rows", () => {
    const Todo = staticModel({
      data: { title: f.string(), rank: f.number(0).indexed("ord") },
    });
    const appScope = scope();
    const todos = collection(Todo, appScope);
    const first = scoped(appScope, () => todos.add({ id: "a", title: "A", rank: 1 }));
    scoped(appScope, () => todos.add({ id: "b", title: "B", rank: 2 }));
    const ordered = todos.sort(Todo.rank.asc);
    const target = container();
    const mounts = vi.fn();
    function Row(props: { item: () => InstanceOf<typeof Todo> }) {
      onMount(() => mounts(props.item().id));
      return h(
        "li",
        { "data-id": props.item().id },
        h("input", { "data-draft": props.item().id }),
        () => props.item().title.value,
      );
    }
    attach(
      () =>
        h(
          "ul",
          null,
          For({
            each: ordered,
            children: (item) => h(Row, { item }),
          }),
        ),
      target,
      appScope,
    );

    const rowA = target.querySelector<HTMLLIElement>('[data-id="a"]')!;
    const inputA = rowA.querySelector("input")!;
    inputA.value = "unsaved draft";
    scoped(appScope, () => {
      first.rank.value = 3;
    });

    expect(Array.from(target.querySelectorAll("li"), (row) => row.getAttribute("data-id"))).toEqual(
      ["b", "a"],
    );
    expect(target.querySelector('[data-id="a"]')).toBe(rowA);
    expect(rowA.querySelector("input")).toBe(inputA);
    expect(inputA.value).toBe("unsaved draft");
    expect(mounts.mock.calls).toEqual([["a"], ["b"]]);
  });

  it.each(["definition", "collection"])(
    "hydrates a %s-backed list using matching request-local collections",
    (kind) => {
      const Todo = staticModel({ data: { title: f.string() } });
      const seed = (appScope: Scope) => {
        const todos = collection(Todo, appScope);
        scoped(appScope, () => {
          todos.add({ id: "a", title: "Alpha" });
          todos.add({ id: "b", title: "Beta" });
        });
        return todos;
      };
      const row = (item: () => InstanceOf<typeof Todo>) =>
        h("li", { "data-id": item().id }, () => item().title.value);
      const view = () =>
        h(
          "ul",
          null,
          kind === "definition"
            ? For({ each: Todo, children: row })
            : For({ each: collection(Todo), children: row }),
        );

      const serverScope = scope();
      seed(serverScope);
      const target = container(renderToString(view, { scope: serverScope }));
      const rows = Array.from(target.querySelectorAll("li"));
      const clientScope = scope();
      const clientTodos = seed(clientScope);
      disposers.push(hydrate(view, target, { scope: clientScope }));

      expect(Array.from(target.querySelectorAll("li"))).toEqual(rows);
      expect(rows.map((row) => row.textContent)).toEqual(["Alpha", "Beta"]);
      scoped(clientScope, () => {
        clientTodos.get("a")!.title.value = "Updated";
      });
      expect(target.querySelector('[data-id="a"]')).toBe(rows[0]);
      expect(rows[0]?.textContent).toBe("Updated");
    },
  );
});
