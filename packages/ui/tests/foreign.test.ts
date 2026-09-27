// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { scope, scoped, store } from "@virentia/core";
import { createElement as h, hydrate } from "../lib";
import { foreignTree } from "../lib/runtime";
import { renderToString } from "../lib/server";

afterEach(() => {
  document.body.textContent = "";
});

describe("opaque foreign hosts", () => {
  it("passes server HTML intact to the foreign hydrator and validates the renderer kind", () => {
    const mounted = vi.fn();
    const view = (kind = "test") =>
      h(
        "main",
        null,
        foreignTree({
          kind,
          node: "server",
          serverRender: () => "<button>server</button>",
          mount(host, _node, _scope, options) {
            mounted(host.firstElementChild, options.hydrate);
            return { update() {}, dispose() {} };
          },
        }),
        h("i", null, "native"),
      );
    const container = document.createElement("div");
    container.innerHTML = renderToString(() => view());
    document.body.append(container);
    const button = container.querySelector("button")!;
    const native = container.querySelector("i")!;

    expect(() => hydrate(() => view("different"), container)).toThrow("a different SSR host");
    expect(mounted).not.toHaveBeenCalled();
    expect(container.querySelector("button")).toBe(button);

    const dispose = hydrate(() => view(), container);
    expect(mounted).toHaveBeenCalledWith(button, true);
    expect(container.querySelector("i")).toBe(native);
    expect(container.querySelector("button")).toBe(button);
    dispose();
  });

  it("hydrates the empty server host, updates its live node and disposes before removing it", () => {
    const value = store("first");
    const reads = vi.fn();
    const mounts = vi.fn();
    const updates = vi.fn();
    const disposes = vi.fn();

    function Foreign() {
      return foreignTree({
        as: "section",
        get node() {
          reads();
          return value.value;
        },
        mount(host, initial, suppliedScope) {
          mounts(initial, suppliedScope, host.nextElementSibling?.tagName);
          host.textContent = initial;
          return {
            update(next) {
              updates(next);
              host.textContent = next;
            },
            dispose() {
              disposes(host.isConnected);
              host.textContent = "";
            },
          };
        },
      });
    }

    const view = () =>
      h("main", null, h("b", null, "native"), h(Foreign, null), h("i", null, "last"));
    const serverScope = scope();
    const html = renderToString(view, { scope: serverScope });
    expect(html).toContain("<section></section>");
    expect(reads).not.toHaveBeenCalled(); // Foreign content is client-only SSR.
    expect(mounts).not.toHaveBeenCalled();

    const container = document.createElement("div");
    container.innerHTML = html;
    document.body.append(container);
    const host = container.querySelector("section")!;
    const native = container.querySelector("b")!;
    const appScope = scope();
    const dispose = hydrate(view, container, { scope: appScope });

    expect(container.querySelector("section")).toBe(host);
    expect(container.querySelector("b")).toBe(native);
    expect(mounts).toHaveBeenCalledWith("first", appScope, "I");
    expect(reads).toHaveBeenCalledTimes(1);
    expect(host.textContent).toBe("first");

    scoped(appScope, () => {
      value.value = "second";
    });
    expect(updates).toHaveBeenCalledWith("second");
    expect(host.textContent).toBe("second");

    dispose();
    expect(disposes).toHaveBeenCalledWith(true);
    expect(host.isConnected).toBe(false);
  });

  it("rejects hosts whose HTML parsing would not preserve an owned container", () => {
    for (const as of ["script", "input", "svg", "template", "DIV", "x>y"]) {
      expect(() =>
        renderToString(() =>
          foreignTree({
            as,
            node: null,
            mount: () => ({
              update() {},
              dispose() {},
            }),
          }),
        ),
      ).toThrow("non-void HTML host");
    }
  });

  it("does not mount a foreign renderer when later native hydration fails", () => {
    const mounted = vi.fn();
    const view = () =>
      h(
        "main",
        null,
        foreignTree({
          kind: "test",
          node: "client",
          serverRender: () => "<button>server</button>",
          mount: mounted,
        }),
        h("i", null, "last"),
      );
    const container = document.createElement("div");
    container.innerHTML = renderToString(view);
    document.body.append(container);
    const button = container.querySelector("button")!;
    container.querySelector("i")!.replaceWith(document.createElement("b"));

    expect(() => hydrate(view, container)).toThrow("Hydration mismatch");
    expect(mounted).not.toHaveBeenCalled();
    expect(container.querySelector("button")).toBe(button);
  });
});
