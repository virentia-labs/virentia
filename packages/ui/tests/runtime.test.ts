// @vitest-environment happy-dom

import { computed, reaction, scope, scoped, setErrorReporter, store } from "@virentia/core";
import type { Scope } from "@virentia/core";
import { setActiveScope } from "@virentia/core/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createContext,
  createElement as h,
  For,
  Portal,
  render,
  Show,
  useContext,
  useScope,
} from "../lib";
import { onMount, onUnmount } from "../lib/runtime";

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
  it("runs components once and updates the existing text and element nodes", () => {
    const appScope = scope();
    const count = store(0);
    let setups = 0;

    function Counter() {
      setups += 1;
      return h("p", null, () => count.value);
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
          onInput(event: Event) {
            value.value = (event.currentTarget as HTMLInputElement).value.toUpperCase();
          },
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

describe("component lifetimes", () => {
  it.each(["dynamic", "Show"])(
    "mounts a committed %s replacement when old cleanup throws",
    (kind) => {
      const appScope = scope();
      const visible = store(true);
      const mounted = vi.fn();
      const report = vi.fn();
      setErrorReporter(report);
      function Old() {
        onUnmount(() => {
          throw new Error("old cleanup failed");
        });
        return h("span", null, "old");
      }
      function Next() {
        onMount(mounted);
        return h("span", null, "next");
      }
      mount(
        () =>
          kind === "Show"
            ? h(Show, {
                when: () => visible.value,
                children: h(Old, null),
                fallback: h(Next, null),
              })
            : () => (visible.value ? h(Old, null) : h(Next, null)),
        appScope,
      );
      scoped(appScope, () => {
        visible.value = false;
      });
      expect(report).toHaveBeenCalled();
      expect(container.textContent).toBe("next");
      expect(mounted).toHaveBeenCalledTimes(1);
    },
  );

  it("mounts with connected DOM and disposes bindings, listeners, and cleanup exactly once", () => {
    const appScope = scope();
    const count = store(0);
    const cleanup = vi.fn();
    const mounted = vi.fn();
    const read = vi.fn(() => count.value);

    function Counter() {
      onMount(() => mounted(container.querySelector("button")?.isConnected));
      onUnmount(cleanup);
      return h("button", { onClick: () => (count.value += 1) }, read);
    }

    const dispose = mount(() => h(Counter, null), appScope);
    const button = container.querySelector("button")!;
    expect(mounted).toHaveBeenCalledTimes(1);
    expect(mounted).toHaveBeenCalledWith(true);

    button.click();
    expect(button.textContent).toBe("1");
    const readsBeforeDispose = read.mock.calls.length;
    dispose();
    dispose();
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(container.childNodes.length).toBe(0);

    button.click();
    expect(scoped(appScope, () => count.value)).toBe(1);
    scoped(appScope, () => {
      count.value = 2;
    });
    expect(read).toHaveBeenCalledTimes(readsBeforeDispose);
  });

  it("inherits and shadows context through delayed conditional mounts", () => {
    const Context = createContext("default");
    const appScope = scope();
    const visible = store(false);
    const label = () => h("span", null, useContext(Context));

    mount(
      () =>
        h(
          "section",
          null,
          h(label, null),
          h(
            Context.Provider,
            { value: "outer" },
            h(Show, { when: () => visible.value }, h(label, null)),
            h(Context.Provider, { value: "inner" }, h(label, null)),
            h(label, null),
          ),
        ),
      appScope,
    );

    expect(Array.from(container.querySelectorAll("span"), (node) => node.textContent)).toEqual([
      "default",
      "inner",
      "outer",
    ]);

    scoped(appScope, () => {
      visible.value = true;
    });

    expect(Array.from(container.querySelectorAll("span"), (node) => node.textContent)).toEqual([
      "default",
      "outer",
      "inner",
      "outer",
    ]);
  });

  it("updates a live context accessor without rerunning its consumer setup", () => {
    const appScope = scope();
    const theme = store("light");
    const Theme = createContext("default");
    let setups = 0;

    function Consumer() {
      setups += 1;
      const value = useContext(Theme);
      return h("span", null, value);
    }

    mount(
      () =>
        h(
          Theme.Provider,
          {
            get value() {
              return theme.value;
            },
          },
          h(Consumer, null),
        ),
      appScope,
    );
    const element = container.querySelector("span")!;
    expect(element.textContent).toBe("light");

    scoped(appScope, () => {
      theme.value = "dark";
    });

    expect(element.textContent).toBe("dark");
    expect(container.querySelector("span")).toBe(element);
    expect(setups).toBe(1);
  });

  it("inherits context through a portal and removes only its external subtree on dispose", () => {
    const Context = createContext("default");
    const target = document.createElement("aside");
    const existing = document.createElement("span");
    existing.textContent = "existing";
    target.append(existing);
    document.body.append(target);
    disposers.push(() => target.remove());
    const cleanup = vi.fn();

    function Content() {
      const value = useContext(Context);
      onUnmount(cleanup);
      return h("span", { "data-portal": true }, value);
    }

    const dispose = mount(() =>
      h(Context.Provider, { value: "provided" }, h(Portal, { mount: target }, h(Content, null))),
    );

    expect(container.querySelector("span")).toBeNull();
    expect(target.querySelector("[data-portal]")?.textContent).toBe("provided");
    dispose();

    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(Array.from(target.childNodes)).toEqual([existing]);
    expect(target.textContent).toBe("existing");
  });

  it("owns scope-bound reactions and stops them when the component unmounts", () => {
    const appScope = scope();
    const count = store(0);
    const incidental = store(0);
    const lifecycle: string[] = [];
    let setups = 0;

    function EffectOwner() {
      setups += 1;
      reaction({
        scope: useScope(),
        run() {
          lifecycle.push(`run:${count.value}`);
        },
      });
      onUnmount(() => lifecycle.push("unmount"));
      return null;
    }

    const dispose = mount(() => h(EffectOwner, null), appScope);
    expect(lifecycle).toEqual(["run:0"]);

    scoped(appScope, () => {
      count.value = 1;
    });
    expect(lifecycle).toEqual(["run:0", "run:1"]);

    scoped(appScope, () => {
      incidental.value = 10;
    });
    expect(lifecycle).toEqual(["run:0", "run:1"]);

    scoped(appScope, () => {
      count.value = 2;
    });
    dispose();
    dispose();
    expect(lifecycle).toEqual(["run:0", "run:1", "run:2", "unmount"]);
    expect(setups).toBe(1);

    scoped(appScope, () => {
      count.value = 3;
    });
    expect(lifecycle).toHaveLength(4);
  });

  it("reports a reaction failure and still stops the reaction on unmount", () => {
    const appScope = scope();
    const count = store(0);
    const runs: number[] = [];
    const report = vi.fn();
    setErrorReporter(report);

    function EffectOwner() {
      reaction({
        scope: useScope(),
        run() {
          const value = count.value;
          runs.push(value);
          if (value === 1) throw new Error("effect failed");
        },
      });
      return null;
    }

    const dispose = mount(() => h(EffectOwner, null), appScope);
    scoped(appScope, () => {
      count.value = 1;
    });
    expect(report).toHaveBeenCalled();
    expect(runs).toEqual([0, 1]);

    scoped(appScope, () => {
      count.value = 2;
    });
    dispose();
    expect(runs).toEqual([0, 1, 2]);
    scoped(appScope, () => {
      count.value = 3;
    });
    expect(runs).toEqual([0, 1, 2]);
  });

  it("disposes inactive Show branches and does not track reads from child setup", () => {
    const appScope = scope();
    const visible = store(true);
    const setupValue = store("initial");
    const count = store(0);
    const cleanup = vi.fn();
    const read = vi.fn(() => count.value);
    let setups = 0;

    function Child() {
      setups += 1;
      const initial = setupValue.value;
      onUnmount(cleanup);
      return h("span", { "data-initial": initial }, read);
    }

    mount(
      () =>
        h(Show, { when: () => visible.value, fallback: h("i", null, "hidden") }, h(Child, null)),
      appScope,
    );
    const span = container.querySelector("span");

    scoped(appScope, () => {
      setupValue.value = "changed";
      count.value = 1;
    });
    expect(setups).toBe(1);
    expect(container.querySelector("span")).toBe(span);
    expect(container.textContent).toBe("1");

    scoped(appScope, () => {
      visible.value = false;
    });
    expect(container.textContent).toBe("hidden");
    expect(cleanup).toHaveBeenCalledTimes(1);
    const readsWhileHidden = read.mock.calls.length;
    scoped(appScope, () => {
      count.value = 2;
    });
    expect(read).toHaveBeenCalledTimes(readsWhileHidden);

    scoped(appScope, () => {
      visible.value = true;
    });
    expect(setups).toBe(2);
    expect(container.querySelector("span")?.getAttribute("data-initial")).toBe("changed");
    expect(container.textContent).toBe("2");
  });

  it("keeps a Show branch mounted while its condition stays truthy", () => {
    const appScope = scope();
    const selected = store(1);
    let setups = 0;

    function Details() {
      setups += 1;
      return h("input", null);
    }

    mount(() => h(Show, { when: () => selected.value }, h(Details, null)), appScope);
    const input = container.querySelector("input")!;
    input.value = "unsaved";

    scoped(appScope, () => {
      selected.value = 2;
    });

    expect(container.querySelector("input")).toBe(input);
    expect(input.value).toBe("unsaved");
    expect(setups).toBe(1);
  });

  it("cleans partially mounted DOM, subscriptions, and listeners after an initial render error", () => {
    const appScope = scope();
    const count = store(0);
    const cleanup = vi.fn();
    const read = vi.fn(() => count.value);
    const captured: HTMLButtonElement[] = [];

    function WorkingChild() {
      onUnmount(cleanup);
      return h(
        "button",
        {
          ref(node: HTMLButtonElement) {
            if (node) captured.push(node);
          },
          onClick: () => (count.value += 1),
        },
        read,
      );
    }

    function BrokenChild(): never {
      throw new Error("initial mount failed");
    }

    expect(() =>
      render(() => h("div", null, h(WorkingChild, null), h(BrokenChild, null)), container, {
        scope: appScope,
      }),
    ).toThrow("initial mount failed");
    expect(container.childNodes.length).toBe(0);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(captured).toHaveLength(1);
    const readsAfterFailure = read.mock.calls.length;

    captured[0].click();
    expect(scoped(appScope, () => count.value)).toBe(0);
    scoped(appScope, () => {
      count.value = 3;
    });
    expect(read).toHaveBeenCalledTimes(readsAfterFailure);
  });

  it("can restore the previous dynamic value after a replacement fails to mount", () => {
    const appScope = scope();
    const broken = store(false);
    const report = vi.fn();
    setErrorReporter(report);
    function Broken(): never {
      throw new Error("replacement failed");
    }

    mount(() => h("div", null, () => (broken.value ? h(Broken, null) : "working")), appScope);
    expect(container.textContent).toBe("working");

    scoped(appScope, () => {
      broken.value = true;
    });
    expect(report).toHaveBeenCalled();

    scoped(appScope, () => {
      broken.value = false;
    });
    expect(container.textContent).toBe("working");
  });

  it("keeps the previous Show branch usable after the next branch fails to mount", () => {
    const appScope = scope();
    const visible = store(false);
    const report = vi.fn();
    const cleanup = vi.fn();
    setErrorReporter(report);

    function Broken(): never {
      onUnmount(cleanup);
      throw new Error("Show branch failed");
    }

    mount(
      () => h(Show, { when: () => visible.value, fallback: h("input", null) }, h(Broken, null)),
      appScope,
    );
    const input = container.querySelector("input")!;
    input.value = "unsaved fallback";

    scoped(appScope, () => {
      visible.value = true;
    });
    expect(report).toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(container.querySelector("input")).toBe(input);

    scoped(appScope, () => {
      visible.value = false;
    });
    expect(container.querySelector("input")).toBe(input);
    expect(input.value).toBe("unsaved fallback");
  });

  it("cleans DOM, listeners, and subscriptions when an update-time onMount fails", () => {
    const appScope = scope();
    const visible = store(false);
    const count = store(0);
    const report = vi.fn();
    const cleanup = vi.fn();
    const read = vi.fn(() => count.value);
    const buttons: HTMLButtonElement[] = [];
    setErrorReporter(report);

    function BrokenMount() {
      onUnmount(cleanup);
      onMount(() => {
        throw new Error("mount hook failed");
      });
      return h(
        "button",
        {
          ref: (node: HTMLButtonElement) => {
            buttons.push(node);
          },
          onClick: () => (count.value += 1),
        },
        read,
      );
    }

    mount(() => h(Show, { when: () => visible.value }, h(BrokenMount, null)), appScope);
    scoped(appScope, () => {
      visible.value = true;
    });

    expect(report).toHaveBeenCalled();
    expect(buttons).toHaveLength(1);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(container.querySelector("button")).toBeNull();
    const readsAfterFailure = read.mock.calls.length;
    buttons[0].click();
    expect(scoped(appScope, () => count.value)).toBe(0);
    scoped(appScope, () => {
      count.value = 1;
    });
    expect(read).toHaveBeenCalledTimes(readsAfterFailure);
  });
});

describe("keyed lists", () => {
  interface Item {
    id: string;
    label: string;
  }

  it("preserves row state, DOM, typed input, and focus across reorder and immutable replacement", () => {
    const appScope = scope();
    const items = store<Item[]>([
      { id: "a", label: "Alpha" },
      { id: "b", label: "Beta" },
    ]);
    const setups: string[] = [];
    const cleaned: string[] = [];

    mount(
      () =>
        h(
          "ul",
          null,
          h(For<Item>, {
            each: () => items.value,
            by: (item: Item) => item.id,
            children(item: () => Item, index: () => number) {
              const id = item().id;
              setups.push(id);
              const clicks = store(0);
              onUnmount(() => cleaned.push(id));
              return h(
                "li",
                { "data-id": id },
                h("span", null, () => `${index()}:${item().label}`),
                h("input", null),
                h("button", { onClick: () => (clicks.value += 1) }, () => clicks.value),
              );
            },
          }),
        ),
      appScope,
    );

    const a = container.querySelector<HTMLLIElement>('[data-id="a"]')!;
    const b = container.querySelector<HTMLLIElement>('[data-id="b"]')!;
    const input = a.querySelector("input")!;
    input.value = "draft in progress";
    input.focus();
    input.setSelectionRange(2, 7);
    a.querySelector("button")!.click();

    scoped(appScope, () => {
      items.value = [
        { id: "b", label: "Beta updated" },
        { id: "a", label: "Alpha updated" },
      ];
    });

    expect(Array.from(container.querySelectorAll("li"))).toEqual([b, a]);
    expect(a.querySelector("span")?.textContent).toBe("1:Alpha updated");
    expect(b.querySelector("span")?.textContent).toBe("0:Beta updated");
    expect(a.querySelector("button")?.textContent).toBe("1");
    expect(a.querySelector("input")).toBe(input);
    expect(input.value).toBe("draft in progress");
    expect(document.activeElement).toBe(input);
    expect([input.selectionStart, input.selectionEnd]).toEqual([2, 7]);
    expect(setups).toEqual(["a", "b"]);
    expect(cleaned).toEqual([]);

    scoped(appScope, () => {
      items.value = [
        { id: "a", label: "Alpha final" },
        { id: "c", label: "Gamma" },
      ];
    });

    expect(container.querySelector('[data-id="a"]')).toBe(a);
    expect(a.querySelector("span")?.textContent).toBe("0:Alpha final");
    expect(setups).toEqual(["a", "b", "c"]);
    expect(cleaned).toEqual(["b"]);
  });

  it("does not orphan new rows when a later row throws during an update", () => {
    const appScope = scope();
    const items = store<string[]>([]);
    const count = store(0);
    const read = vi.fn(() => count.value);
    const cleanup = vi.fn();
    const reports = vi.fn();
    setErrorReporter(reports);

    mount(
      () =>
        h(For<string>, {
          each: () => items.value,
          children(item: () => string) {
            if (item() === "broken") throw new Error("row failed");
            onUnmount(cleanup);
            return h("button", { onClick: () => (count.value += 1) }, read);
          },
        }),
      appScope,
    );

    scoped(appScope, () => {
      items.value = ["working", "broken"];
    });
    expect(reports).toHaveBeenCalled();

    scoped(appScope, () => {
      items.value = ["working"];
    });
    expect(container.querySelectorAll("button")).toHaveLength(1);
    container.querySelector("button")!.click();
    expect(container.textContent).toBe("1");

    scoped(appScope, () => {
      items.value = [];
    });
    expect(container.querySelectorAll("button")).toHaveLength(0);
    const readsAfterRemoval = read.mock.calls.length;
    scoped(appScope, () => {
      count.value = 2;
    });
    expect(read).toHaveBeenCalledTimes(readsAfterRemoval);
    expect(cleanup).toHaveBeenCalled();
  });

  it("does not retain removed row bookkeeping in a long-lived scope", () => {
    const appScope = scope();
    const items = store<Item[]>([]);
    mount(
      () =>
        h(For<Item>, {
          each: () => items.value,
          by: (item: Item) => item.id,
          children: (item: () => Item, index: () => number) =>
            h("span", null, () => `${index()}:${item().label}`),
        }),
      appScope,
    );
    const baseline = appScope.values.size;

    for (let index = 0; index < 25; index += 1) {
      scoped(appScope, () => {
        items.value = [{ id: `row-${index}`, label: `item ${index}` }];
      });
      expect(container.textContent).toBe(`0:item ${index}`);

      scoped(appScope, () => {
        items.value = [{ id: `row-${index}`, label: `updated ${index}` }];
      });
      expect(container.textContent).toBe(`0:updated ${index}`);

      scoped(appScope, () => {
        items.value = [];
      });
      expect(container.querySelectorAll("span")).toHaveLength(0);
      expect(appScope.values.size).toBe(baseline);
    }
  });

  it("finishes every row removal and updates retained rows even when a cleanup throws", () => {
    const appScope = scope();
    const items = store<Item[]>([
      { id: "a", label: "Alpha" },
      { id: "b", label: "Beta" },
      { id: "c", label: "Gamma" },
    ]);
    const count = store(0);
    const cleaned: string[] = [];
    const mounted: string[] = [];
    const reads = new Map<string, ReturnType<typeof vi.fn>>();
    const report = vi.fn();
    setErrorReporter(report);
    mount(
      () =>
        h(For<Item>, {
          each: () => items.value,
          by: (item: Item) => item.id,
          children(item: () => Item, index: () => number) {
            const id = item().id;
            onMount(() => {
              mounted.push(id);
            });
            onUnmount(() => {
              cleaned.push(id);
              if (id === "a") throw new Error("row cleanup failed");
            });
            const read = vi.fn(() => `${index()}:${item().label}:${count.value}`);
            reads.set(id, read);
            return h("span", { "data-id": id }, read);
          },
        }),
      appScope,
    );
    const retained = container.querySelector('[data-id="c"]')!;

    scoped(appScope, () => {
      items.value = [
        { id: "c", label: "Updated" },
        { id: "d", label: "New" },
      ];
    });

    expect(report).toHaveBeenCalled();
    expect(new Set(cleaned)).toEqual(new Set(["a", "b"]));
    expect(
      Array.from(container.querySelectorAll("span"), (node) => node.getAttribute("data-id")),
    ).toEqual(["c", "d"]);
    expect(container.querySelector('[data-id="c"]')).toBe(retained);
    expect(mounted).toEqual(["a", "b", "c", "d"]);
    expect(retained.textContent).toBe("0:Updated:0");
    const removedReads = [reads.get("a")!.mock.calls.length, reads.get("b")!.mock.calls.length];

    scoped(appScope, () => {
      count.value = 1;
    });
    expect(retained.textContent).toBe("0:Updated:1");
    expect([reads.get("a")!.mock.calls.length, reads.get("b")!.mock.calls.length]).toEqual(
      removedReads,
    );
  });

  it("can remount a list fallback after its previous cleanup throws", () => {
    const appScope = scope();
    const items = store<string[]>([]);
    const report = vi.fn();
    let mounts = 0;
    setErrorReporter(report);

    function Fallback() {
      const initial = ++mounts === 1;
      onUnmount(() => {
        if (initial) throw new Error("fallback cleanup failed");
      });
      return h("i", null, "empty");
    }

    mount(
      () =>
        h(For<string>, {
          each: () => items.value,
          fallback: h(Fallback, null),
          children: (item: () => string) => h("span", null, item),
        }),
      appScope,
    );
    expect(container.textContent).toBe("empty");

    scoped(appScope, () => {
      items.value = ["row"];
    });
    expect(report).toHaveBeenCalled();
    expect(container.textContent).toBe("row");

    scoped(appScope, () => {
      items.value = [];
    });
    expect(container.textContent).toBe("empty");
    expect(mounts).toBe(2);
  });
});
