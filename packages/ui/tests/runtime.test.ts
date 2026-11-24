// @vitest-environment happy-dom

import { computed, reaction, scope, scoped, setErrorReporter, store } from "@virentia/core";
import type { Scope } from "@virentia/core";
import { setActiveScope } from "@virentia/core/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { action, createElement as h, render } from "../lib";

let container: HTMLDivElement;
let disposers: Array<() => void>;

beforeEach(() => {
  setActiveScope(null);
  container = document.createElement("div");
  document.body.append(container);
  disposers = [];
});

afterEach(() => {
  for (const dispose of disposers.reverse()) dispose();
  container.remove();
  setActiveScope(null);
  setErrorReporter(null);
});

function mount(view: Parameters<typeof render>[0], appScope: Scope = scope()) {
  const dispose = render(view, container, { scope: appScope });
  disposers.push(dispose);
  return dispose;
}

describe("fine-grained DOM bindings", () => {
  it("keeps explicit h children overlaid while source props remain live", () => {
    const props = { title: "first", children: "ignored" };
    const descriptor = h("div", props, "explicit");
    expect(Object.keys(descriptor)).toEqual(["type", "props"]);
    expect(JSON.parse(JSON.stringify(descriptor))).toEqual({
      type: "div",
      props: { title: "first", children: "explicit" },
    });
    expect(descriptor.props.children).toBe("explicit");
    expect(Reflect.ownKeys(descriptor.props)).toEqual(["title", "children"]);
    props.title = "second";
    expect(descriptor.props.title).toBe("second");
    expect(Object.getPrototypeOf(descriptor.props)).toBe(Object.prototype);
    mount(() => descriptor);
    expect(container.firstElementChild!.getAttribute("title")).toBe("second");
    expect(container.textContent).toBe("explicit");
  });
  it("runs components once and updates the existing text and element nodes", () => {
    const appScope = scope();
    const count = store(0);
    let setups = 0;

    function Counter() {
      setups += 1;
      return h("p", null, count);
    }

    mount(() => h(Counter, null), appScope);
    const paragraph = container.querySelector("p")!;
    const text = Array.from(paragraph.childNodes).find((node) => node.nodeType === 3)!;

    scoped(appScope, () => {
      count.value = 7;
    });

    expect(container.querySelector("p")).toBe(paragraph);
    expect(Array.from(paragraph.childNodes)).toContain(text);
    expect(text.textContent).toBe("7");
    expect(paragraph.textContent).toBe("7");
    expect(setups).toBe(1);
  });

  it("preserves component prop getters until their individual bindings read them", () => {
    const appScope = scope();
    const name = store("first");
    let setups = 0;

    function Label(props: { value: string }) {
      setups += 1;
      return h("span", null, () => props.value);
    }

    mount(
      () =>
        h(Label, {
          get value() {
            return name.value;
          },
        }),
      appScope,
    );

    scoped(appScope, () => {
      name.value = "second";
    });

    expect(container.textContent).toBe("second");
    expect(setups).toBe(1);
  });

  it("replaces conditional dependencies without rerunning on the inactive branch", () => {
    const appScope = scope();
    const chooseLeft = store(true);
    const left = store("left");
    const right = store("right");
    const read = vi.fn(() => (chooseLeft.value ? left.value : right.value));

    mount(() => h("span", null, read), appScope);
    expect(read).toHaveBeenCalledTimes(1);

    scoped(appScope, () => {
      right.value = "right changed";
    });
    expect(read).toHaveBeenCalledTimes(1);

    scoped(appScope, () => {
      chooseLeft.value = false;
    });
    expect(container.textContent).toBe("right changed");
    expect(read).toHaveBeenCalledTimes(2);

    scoped(appScope, () => {
      left.value = "left changed";
    });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("binds classes, native properties, attributes, and style without replacing the element", () => {
    const appScope = scope();
    const active = store(false);
    mount(
      () =>
        h("button", {
          get className() {
            return active.value ? "active" : "idle";
          },
          get disabled() {
            return active.value;
          },
          get "aria-pressed"() {
            return active.value;
          },
          get "data-label"() {
            return active.value ? null : "ready";
          },
          get style() {
            return active.value
              ? { color: "red", "--tone": "warm" }
              : { color: "blue", backgroundColor: "black", "--tone": "cool" };
          },
        }),
      appScope,
    );
    const button = container.querySelector("button")!;
    expect(button.className).toBe("idle");
    expect(button.disabled).toBe(false);
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(button.style.backgroundColor).toBe("black");

    scoped(appScope, () => {
      active.value = true;
    });

    expect(container.querySelector("button")).toBe(button);
    expect(button.className).toBe("active");
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(button.hasAttribute("data-label")).toBe(false);
    expect(button.style.color).toBe("red");
    expect(button.style.backgroundColor).toBe("");
    expect(button.style.getPropertyValue("--tone")).toBe("warm");
  });

  it("updates controlled input properties and runs DOM events in the captured scope", () => {
    const appScope = scope();
    const value = store("initial");
    mount(
      () =>
        h("input", {
          get value() {
            return value.value;
          },
          onInput: action((event: Event) => {
            value.value = (event.currentTarget as HTMLInputElement).value.toUpperCase();
          }),
        }),
      appScope,
    );
    const input = container.querySelector("input")!;
    expect(input.value).toBe("initial");

    input.value = "typed";
    input.dispatchEvent(new Event("input", { bubbles: true }));

    expect(scoped(appScope, () => value.value)).toBe("TYPED");
    expect(input.value).toBe("TYPED");
    expect(container.querySelector("input")).toBe(input);
  });

  it("keeps separate roots isolated even when they share a computed store", () => {
    const count = store(1);
    const doubled = computed(() => count.value * 2);
    const a = scope({ values: [[count, 2]] });
    const b = scope({ values: [[count, 5]] });
    const second = document.createElement("div");
    container.append(second);
    const first = document.createElement("div");
    container.prepend(first);
    disposers.push(render(() => h("span", null, () => doubled.value), first, { scope: a }));
    disposers.push(render(() => h("span", null, () => doubled.value), second, { scope: b }));

    expect(first.textContent).toBe("4");
    expect(second.textContent).toBe("10");

    scoped(a, () => {
      count.value = 3;
    });

    expect(first.textContent).toBe("6");
    expect(second.textContent).toBe("10");
  });

  it("merges classList with the class attribute regardless of prop order", () => {
    const appScope = scope();
    const base = store("first");
    mount(
      () =>
        h("div", {
          classList: { selected: true },
          get className() {
            return base.value;
          },
        }),
      appScope,
    );
    const element = container.querySelector("div")!;
    expect(new Set(element.classList)).toEqual(new Set(["first", "selected"]));

    scoped(appScope, () => {
      base.value = "second";
    });
    expect(new Set(element.classList)).toEqual(new Set(["second", "selected"]));
  });

  it("writes SVG presentation props using their native attribute names", () => {
    const appScope = scope();
    const width = store(2);
    mount(
      () =>
        h(
          "svg",
          { viewBox: "0 0 10 10" },
          h("path", {
            d: "M0 0L10 10",
            get strokeWidth() {
              return width.value;
            },
            fillOpacity: 0.5,
          }),
        ),
      appScope,
    );
    const svg = container.querySelector("svg")!;
    const path = container.querySelector("path")!;
    expect(svg.getAttribute("viewBox")).toBe("0 0 10 10");
    expect(path.getAttribute("stroke-width")).toBe("2");
    expect(path.getAttribute("fill-opacity")).toBe("0.5");

    scoped(appScope, () => {
      width.value = 3;
    });
    expect(path.getAttribute("stroke-width")).toBe("3");
  });

  it("sets a controlled select value after its option children have mounted", () => {
    const appScope = scope();
    const selected = store("b");
    mount(
      () =>
        h(
          "select",
          {
            get value() {
              return selected.value;
            },
          },
          h("option", { value: "a" }, "Alpha"),
          h("option", { value: "b" }, "Beta"),
        ),
      appScope,
    );
    const select = container.querySelector("select")!;
    expect(select.value).toBe("b");
    expect(select.selectedIndex).toBe(1);

    scoped(appScope, () => {
      selected.value = "a";
    });
    expect(select.value).toBe("a");
    expect(select.selectedIndex).toBe(0);
  });
});
