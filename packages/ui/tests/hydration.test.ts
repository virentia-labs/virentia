// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { reaction, scope, scoped, serialize, store, type Scope } from "@virentia/core";
import {
  createElement as h,
  createContext,
  For,
  hydrate,
  Show,
  useContext,
  useId,
  useScope,
} from "../lib";
import { onMount, onUnmount } from "../lib/runtime";
import { renderToString } from "../lib/server";

const disposers: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposers.splice(0).reverse()) dispose();
  document.body.textContent = "";
});
function container(html: string) {
  const root = document.createElement("div");
  root.innerHTML = html;
  document.body.append(root);
  return root;
}
function attach(
  view: Parameters<typeof hydrate>[0],
  root: HTMLDivElement,
  appScope: Scope,
  identifierPrefix?: string,
) {
  const dispose = hydrate(view, root, { scope: appScope, identifierPrefix });
  disposers.push(dispose);
  return dispose;
}

describe("SSR hydration", () => {
  it("claims existing elements/text, restores state before setup and updates in place", () => {
    let setups = 0;
    const count = store(0, undefined, { sid: "counter" });
    function App() {
      setups++;
      return h("button", { onClick: () => count.value++ }, () => count.value);
    }
    const serverScope = scope({ values: [[count, 7]] });
    const root = container(renderToString(() => h(App, null), { scope: serverScope }));
    const button = root.querySelector("button")!;
    const text = Array.from(button.childNodes).find((n) => n.nodeType === 3)!;
    const clientScope = scope({ snapshot: serialize(serverScope) });
    const dispose = attach(() => h(App, null), root, clientScope);
    expect(root.querySelector("button")).toBe(button);
    expect(Array.from(button.childNodes)).toContain(text);
    expect(button.textContent).toBe("7");
    button.click();
    expect(button.textContent).toBe("8");
    expect(text.textContent).toBe("8");
    expect(setups).toBe(2); // once on the server, once on the client
    expect(scoped(serverScope, () => count.value)).toBe(7);
    dispose();
    expect(root.childNodes).toHaveLength(0);
    button.click();
    expect(scoped(clientScope, () => count.value)).toBe(8);
  });

  it("namespaces repeated local store SIDs and reproduces useId across requests", () => {
    let initial = 10;
    const ids: string[] = [];
    function Counter() {
      const count = store(initial++, undefined, { sid: "local-counter" });
      const id = useId();
      ids.push(id);
      return h("button", { id, onClick: () => count.value++ }, () => count.value);
    }
    function App() {
      return h("main", null, h(Counter, null), h(Counter, null));
    }
    const serverScope = scope();
    const html = renderToString(() => h(App, null), {
      scope: serverScope,
      identifierPrefix: "profile",
    });
    const snapshot = serialize(serverScope);
    expect(Object.values(snapshot)).toEqual([10, 11]);
    expect(new Set(Object.keys(snapshot)).size).toBe(2);
    const root = container(html);
    const buttons = Array.from(root.querySelectorAll("button"));
    initial = 99;
    attach(() => h(App, null), root, scope({ snapshot }), "profile");
    expect(ids.slice(2)).toEqual(ids.slice(0, 2));
    expect(new Set(ids.slice(0, 2)).size).toBe(2);
    expect(Array.from(root.querySelectorAll("button"))).toEqual(buttons);
    buttons[1].click();
    expect(buttons.map((button) => button.textContent)).toEqual(["10", "12"]);
  });

  it("preserves keyed row drafts during hydration, reorder, add and remove", () => {
    const items = store(["a", "b"], undefined, { sid: "items" });
    const mount = vi.fn();
    const cleanup = vi.fn();
    function Row(props: { item: () => string }) {
      onMount(mount);
      onUnmount(cleanup);
      return h("li", null, props.item, h("input", { "data-key": props.item() }));
    }
    const view = () =>
      h(
        "ul",
        null,
        h(For<string>, { each: () => items.value, children: (item) => h(Row, { item }) }),
      );
    const serverScope = scope();
    const root = container(renderToString(view, { scope: serverScope }));
    expect(mount).not.toHaveBeenCalled();
    expect(cleanup).not.toHaveBeenCalled();
    const input = root.querySelector<HTMLInputElement>('[data-key="a"]')!;
    input.value = "typed before hydration";
    const clientScope = scope({ snapshot: serialize(serverScope) });
    attach(view, root, clientScope);
    expect(mount).toHaveBeenCalledTimes(2);
    scoped(clientScope, () => {
      items.value = ["b", "a", "c"];
    });
    expect(root.querySelector('[data-key="a"]')).toBe(input);
    expect(input.value).toBe("typed before hydration");
    expect(mount).toHaveBeenCalledTimes(3);
    scoped(clientScope, () => {
      items.value = ["c"];
    });
    expect(cleanup).toHaveBeenCalledTimes(2);
  });

  it("hydrates context, conditional branches, empty regions and adjacent text", () => {
    const Theme = createContext("light");
    const visible = store(true);
    function Label() {
      const theme = useContext(Theme);
      return h("b", null, theme);
    }
    const view = () =>
      h(
        Theme.Provider,
        { value: "dark" },
        h(
          "div",
          null,
          "a",
          "",
          "b",
          () => undefined,
          () => null,
          h(Show, { when: () => visible.value, children: h(Label, null), fallback: "hidden" }),
        ),
      );
    const root = container(renderToString(view));
    const bold = root.querySelector("b");
    const appScope = scope();
    attach(view, root, appScope);
    expect(root.textContent).toBe("abdark");
    expect(root.querySelector("b")).toBe(bold);
    scoped(appScope, () => {
      visible.value = false;
    });
    expect(root.textContent).toBe("abhidden");
  });

  it("hydrates HTML/SVG, void elements and controlled native form values", () => {
    const selected = store("b");
    const text = store("hello <&world");
    const view = () =>
      h(
        "main",
        null,
        h("svg", { viewBox: "0 0 10 10" }, h("circle", { cx: 5, strokeWidth: 2 })),
        h("input", { defaultValue: "draft", disabled: false }),
        h("textarea", {
          get value() {
            return text.value;
          },
        }),
        h(
          "select",
          {
            get value() {
              return selected.value;
            },
          },
          h("option", { value: "a" }, "A"),
          h("option", { value: "b" }, "B"),
        ),
      );
    const root = container(renderToString(view));
    const textarea = root.querySelector("textarea")!;
    const input = root.querySelector("input")!;
    input.value = "user draft";
    const appScope = scope();
    attach(view, root, appScope);
    expect(root.querySelector("textarea")).toBe(textarea);
    expect(textarea.value).toBe("hello <&world");
    expect(input.value).toBe("user draft");
    expect(root.querySelector("select")!.value).toBe("b");
    scoped(appScope, () => {
      selected.value = "a";
      text.value = "updated";
    });
    expect(root.querySelector("select")!.value).toBe("a");
    expect(textarea.value).toBe("updated");
  });

  it("starts mounted reactions after existing DOM is claimed and skips them on the server", () => {
    const count = store(0);
    const effect = vi.fn();
    function App() {
      const appScope = useScope();
      onMount(() => {
        reaction({
          scope: appScope,
          run() {
            effect();
            count.value = 1;
          },
        });
      });
      return h("p", null, () => count.value);
    }
    const root = container(renderToString(() => h(App, null)));
    expect(root.textContent).toBe("0");
    expect(effect).not.toHaveBeenCalled();
    const paragraph = root.querySelector("p");
    attach(() => h(App, null), root, scope());
    expect(root.querySelector("p")).toBe(paragraph);
    expect(root.textContent).toBe("1");
    expect(effect).toHaveBeenCalledTimes(1);
  });

  it("reports mismatches without replacing server DOM or retaining partial listeners", () => {
    const click = vi.fn();
    const root = container(
      renderToString(() => h("div", null, h("button", { onClick: click }, "server"))),
    );
    const html = root.innerHTML;
    const button = root.querySelector("button")!;
    expect(() =>
      hydrate(() => h("div", null, h("button", { onClick: click }, "client")), root),
    ).toThrow("Hydration mismatch");
    expect(root.innerHTML).toBe(html);
    expect(root.querySelector("button")).toBe(button);
    button.click();
    expect(click).not.toHaveBeenCalled();
  });
});
