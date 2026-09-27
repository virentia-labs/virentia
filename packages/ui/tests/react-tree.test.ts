// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { reaction, reactive, scope, scoped, store } from "@virentia/core";
import { useModel, useProvidedScope, useUnit } from "@virentia/react";
import { act, createElement as reactElement, Suspense, useEffect, useId, useState } from "react";
import { createElement as h, hydrate, type ComponentLifecycle } from "../lib";
import { ReactTree } from "../lib/react";
import { ReactTree as ServerReactTree } from "../lib/react-server";
import { renderToString } from "../lib/server";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

afterEach(() => {
  document.body.textContent = "";
});

describe("ReactTree", () => {
  it("hydrates server DOM with matching IDs and preserves React state across Core updates", async () => {
    const count = store(0);
    const label = store("server");
    const mounted = vi.fn();
    const unmounted = vi.fn();
    function Counter(props: { label: string }) {
      const id = useId();
      const value = useUnit(count);
      const [local, setLocal] = useState(0);
      useEffect(() => {
        mounted();
        return unmounted;
      }, []);
      return reactElement(
        "button",
        { id, onClick: () => setLocal(local + 1) },
        `${props.label}:${value}:${local}`,
      );
    }
    const view = (Tree: typeof ReactTree) => () =>
      h(
        "main",
        null,
        h(Tree, {
          get node() {
            return reactElement(Counter, { label: label.value });
          },
        }),
        h(Tree, { node: reactElement(Counter, { label: "other" }) }),
      );
    const html = renderToString(view(ServerReactTree), { scope: scope({ values: [[count, 3]] }) });
    expect(html).toContain('data-ui-ssr="react"');
    expect(html).toContain("server:3:0");
    expect(mounted).not.toHaveBeenCalled();
    const container = document.createElement("div");
    container.innerHTML = html;
    document.body.append(container);
    const buttons = [...container.querySelectorAll("button")];
    const ids = buttons.map((button) => button.id);
    expect(new Set(ids).size).toBe(2);
    const appScope = scope({ values: [[count, 3]] });
    let dispose!: () => void;
    await act(async () => {
      dispose = hydrate(view(ReactTree), container, { scope: appScope });
    });
    expect([...container.querySelectorAll("button")]).toEqual(buttons);
    expect(buttons.map((button) => button.id)).toEqual(ids);
    await act(async () => {
      buttons[0]!.click();
      scoped(appScope, () => {
        label.value = "client";
        count.value = 4;
      });
    });
    expect(container.querySelector("button")).toBe(buttons[0]);
    expect(buttons[0]!.textContent).toBe("client:4:1");
    await act(async () => dispose());
    expect(mounted).toHaveBeenCalledTimes(2);
    expect(unmounted).toHaveBeenCalledTimes(2);
  });

  it("buffers updates until hydration commits, keeping server nodes", async () => {
    const label = store("initial");
    const view = (Tree: typeof ReactTree) => () =>
      h(Tree, {
        get node() {
          return reactElement("span", null, label.value);
        },
      });
    const container = document.createElement("div");
    container.innerHTML = renderToString(view(ServerReactTree));
    document.body.append(container);
    const span = container.querySelector("span");
    const appScope = scope();
    let dispose!: () => void;
    await act(async () => {
      dispose = hydrate(view(ReactTree), container, { scope: appScope });
      scoped(appScope, () => {
        label.value = "updated";
      });
    });
    expect(container.querySelector("span")).toBe(span);
    expect(span?.textContent).toBe("updated");
    await act(async () => dispose());
  });

  it("keeps server DOM when Core state changes immediately after hydrate", async () => {
    const count = store(3);
    function Counter() {
      return reactElement("span", null, useUnit(count));
    }
    const view = (Tree: typeof ReactTree) => () => h(Tree, { node: reactElement(Counter) });
    const container = document.createElement("div");
    container.innerHTML = renderToString(view(ServerReactTree));
    document.body.append(container);
    const span = container.querySelector("span");
    const appScope = scope();
    let dispose!: () => void;
    await act(async () => {
      dispose = hydrate(view(ReactTree), container, { scope: appScope });
      scoped(appScope, () => {
        count.value = 4;
      });
    });
    expect(container.querySelector("span")).toBe(span);
    expect(span?.textContent).toBe("4");
    await act(async () => dispose());
  });

  it("hydrates before a native parent's mounted reaction changes Core state", async () => {
    const count = store(3);
    function Counter() {
      return reactElement("span", null, useUnit(count));
    }
    const view = (Tree: typeof ReactTree) => () => {
      function Parent(_props: {}, { mounted }: ComponentLifecycle<{}>) {
        reaction({
          on: mounted,
          run: ({ scope: parentScope }) => {
            scoped(parentScope, () => {
              count.value = 4;
            });
          },
        });
        return h(Tree, { node: reactElement(Counter) });
      }
      return h(Parent);
    };
    const container = document.createElement("div");
    container.innerHTML = renderToString(view(ServerReactTree));
    document.body.append(container);
    const span = container.querySelector("span");
    let dispose!: () => void;
    await act(async () => {
      dispose = hydrate(view(ReactTree), container);
    });
    expect(container.querySelector("span")).toBe(span);
    expect(span?.textContent).toBe("4");
    await act(async () => dispose());
  });

  it("hydrates sibling React roots before their mounted writes alter Core state", async () => {
    const count = store(3);
    const model = { count };
    let appScope = scope();
    function Counter(props: { write?: boolean }) {
      const value = useUnit(count);
      const shape = useUnit(model);
      const legacy = useModel(model);
      const liveScope = useProvidedScope();
      useEffect(() => {
        if (props.write)
          scoped(liveScope, () => {
            count.value = 4;
          });
      }, []);
      return reactElement("span", null, `${value}:${shape.count}:${legacy.count}`);
    }
    const view = (Tree: typeof ReactTree) => () =>
      h(
        "main",
        null,
        h(Tree, { node: reactElement(Counter, { write: true }) }),
        h(Tree, { node: reactElement(Counter) }),
      );
    const container = document.createElement("div");
    container.innerHTML = renderToString(view(ServerReactTree), { scope: appScope });
    document.body.append(container);
    const spans = [...container.querySelectorAll("span")];
    appScope = scope();
    let dispose!: () => void;
    await act(async () => {
      dispose = hydrate(view(ReactTree), container, { scope: appScope });
    });
    try {
      expect([...container.querySelectorAll("span")]).toEqual(spans);
      expect(spans.map((span) => span.textContent)).toEqual(["4:4:4", "4:4:4"]);
    } finally {
      await act(async () => dispose());
    }
  });

  it("skips React SSR when explicitly disabled", () => {
    const Render = vi.fn(() => reactElement("b", null, "client only"));
    const html = renderToString(() =>
      h(ServerReactTree, { node: reactElement(Render), ssr: false }),
    );
    expect(html).toContain("<div></div>");
    expect(html).not.toContain("data-ui-ssr");
    expect(Render).not.toHaveBeenCalled();
  });

  it("retains server state until a delayed Suspense subtree hydrates", async () => {
    const count = store(3);
    const model = { count };
    const profile = reactive({ amount: 3 });
    const items = reactive([3]);
    let waiting = false;
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    function Reader() {
      if (waiting) throw pending;
      const scalar = useUnit(count);
      const shape = useUnit(model);
      const legacy = useModel(model);
      const object = useUnit(profile);
      const array = useUnit(items);
      return reactElement(
        "span",
        null,
        `${scalar}:${shape.count}:${legacy.count}:${object.amount}:${array[0]}`,
      );
    }
    function Writer() {
      const live = useProvidedScope();
      useEffect(() => {
        scoped(live, () => {
          count.value = 4;
          profile.amount = 4;
          items[0] = 4;
        });
      }, []);
      return null;
    }
    const view = (Tree: typeof ReactTree) => () =>
      h(Tree, {
        node: reactElement(
          "main",
          null,
          reactElement(Suspense, { fallback: "loading" }, reactElement(Reader)),
          reactElement(Writer),
        ),
      });
    const container = document.createElement("div");
    container.innerHTML = renderToString(view(ServerReactTree));
    document.body.append(container);
    const span = container.querySelector("span");
    expect(span?.textContent).toBe("3:3:3:3:3");
    waiting = true;
    let dispose!: () => void;
    try {
      await act(async () => {
        dispose = hydrate(view(ReactTree), container);
      });
      expect(container.querySelector("span")).toBe(span);
      await act(async () => {
        waiting = false;
        release();
        await pending;
      });
      expect(container.querySelector("span")).toBe(span);
      expect(span?.textContent).toBe("4:4:4:4:4");
    } finally {
      if (dispose) await act(async () => dispose());
    }
  });

  it("can dispose immediately after synchronous React hydration commits", async () => {
    const mounted = vi.fn();
    const unmounted = vi.fn();
    function View() {
      useEffect(() => {
        mounted();
        return unmounted;
      }, []);
      return reactElement("span", null, "ready");
    }
    const container = document.createElement("div");
    container.innerHTML = renderToString(() => h(ServerReactTree, { node: reactElement(View) }));
    document.body.append(container);
    await act(async () => {
      const dispose = hydrate(() => h(ReactTree, { node: reactElement(View) }), container);
      dispose();
    });
    expect(container.childNodes).toHaveLength(0);
    expect(mounted).toHaveBeenCalledTimes(1);
    expect(unmounted).toHaveBeenCalledTimes(1);
  });

  it("shares the Core scope, updates in place and unmounts before its host", async () => {
    const count = store(0);
    const label = store("first");
    const mounted = vi.fn();
    const unmounted = vi.fn();
    const reactHostConnectedAtCleanup = vi.fn();

    function Counter(props: { label: string }) {
      const value = useUnit(count);
      const [local, setLocal] = useState(0);
      useEffect(() => {
        mounted();
        return () => {
          unmounted();
          reactHostConnectedAtCleanup(document.querySelector("[data-react-host]")?.isConnected);
        };
      }, []);
      return reactElement(
        "button",
        { onClick: () => setLocal((previous) => previous + 1) },
        `${props.label}:${value}:${local}`,
      );
    }

    const view = () =>
      h(
        "main",
        null,
        h(ReactTree, {
          get node() {
            return reactElement(Counter, { label: label.value });
          },
        }),
        h("span", null, () => label.value),
      );

    const html = renderToString(view, { scope: scope() });
    expect(html).toContain("<div></div>");
    expect(html).not.toContain("first:0"); // React subtree is client-only SSR.
    expect(mounted).not.toHaveBeenCalled();

    const container = document.createElement("div");
    container.innerHTML = html;
    document.body.append(container);
    const host = container.querySelector("main > div")!;
    host.setAttribute("data-react-host", "");
    const native = container.querySelector("span")!;
    const appScope = scope({ values: [[count, 3]] });
    let dispose!: () => void;
    await act(async () => {
      dispose = hydrate(view, container, { scope: appScope });
    });

    expect(container.querySelector("main > div")).toBe(host);
    expect(container.querySelector("span")).toBe(native);
    const button = host.querySelector("button")!;
    expect(button.textContent).toBe("first:3:0");
    expect(mounted).toHaveBeenCalledTimes(1);

    await act(async () => {
      button.click();
      scoped(appScope, () => {
        count.value = 4;
        label.value = "second";
      });
    });
    expect(host.querySelector("button")).toBe(button);
    expect(button.textContent).toBe("second:4:1");
    expect(native.textContent).toBe("second");
    expect(mounted).toHaveBeenCalledTimes(1);

    await act(async () => dispose());
    expect(unmounted).toHaveBeenCalledTimes(1);
    expect(reactHostConnectedAtCleanup).toHaveBeenCalledWith(true);
    expect(host.isConnected).toBe(false);
  });
});
