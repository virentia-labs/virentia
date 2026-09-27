// @vitest-environment happy-dom

import { reaction, scope, scoped, store, type Scope } from "@virentia/core";
import { collection } from "@virentia/core/models";
import { afterEach, describe, expect, it, vi } from "vitest";
import { component, createElement as h, hydrate, render, Show, type Component } from "../lib";
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

function attach(
  view: Parameters<typeof render>[0],
  root: HTMLDivElement,
  appScope: Scope,
): () => void {
  const dispose = render(view, root, { scope: appScope });
  disposers.push(dispose);
  return dispose;
}

describe("component lifecycle events", () => {
  it("also passes lifecycle sources to an ordinary function component", () => {
    const appScope = scope();
    const root = container();
    const mounted = vi.fn();
    const unmounted = vi.fn();
    const Plain: Component<{ id: string }> = (props, events) => {
      reaction({ on: events.mounted, run: mounted });
      reaction({ on: events.unmounted, run: unmounted });
      return h("span", null, props.id);
    };

    const dispose = attach(() => h(Plain, { id: "plain" }), root, appScope);
    expect(mounted).toHaveBeenCalledTimes(1);
    expect(mounted.mock.calls[0]?.[0]).toMatchObject({ id: "plain", scope: appScope });
    dispose();
    expect(unmounted).toHaveBeenCalledTimes(1);
    expect(unmounted.mock.calls[0]?.[0]).toMatchObject({ id: "plain", scope: appScope });
  });

  it("delivers per-instance mounted and unmounted payloads without cross-firing siblings", () => {
    const appScope = scope();
    const root = container();
    const showFirst = store(true);
    const mounted: Array<{
      id: string;
      model: object;
      props: { id: string; label: string };
      scope: Scope;
    }> = [];
    const unmounted: typeof mounted = [];
    const mountedSources: Array<{ readonly node: unknown }> = [];
    const unmountedSources: Array<{ readonly node: unknown }> = [];
    const Item = component(
      (props: { id: string; label: string }, { mounted: onMounted, unmounted: onUnmounted }) => {
        mountedSources.push(onMounted);
        unmountedSources.push(onUnmounted);
        reaction({ on: onMounted, run: (payload) => mounted.push(payload) });
        reaction({ on: onUnmounted, run: (payload) => unmounted.push(payload) });
        return h("span", { "data-id": props.id }, () => props.label);
      },
      { keep: true },
    );

    attach(
      () =>
        h(
          "div",
          null,
          h(Show, { when: () => showFirst.value }, h(Item, { id: "a", label: "First" })),
          h(Item, { id: "b", label: "Second" }),
        ),
      root,
      appScope,
    );
    const models = collection(Item.model, appScope);
    expect(mounted.map(({ id }) => id)).toEqual(["a", "b"]);
    expect(mountedSources[0]).not.toBe(mountedSources[1]);
    expect(unmountedSources[0]).not.toBe(unmountedSources[1]);
    expect(mountedSources[0]?.node).toBe(mountedSources[1]?.node);
    expect(unmountedSources[0]?.node).toBe(unmountedSources[1]?.node);
    expect(mountedSources[0]?.node).not.toBe(unmountedSources[0]?.node);
    expect(mounted[0]).toMatchObject({
      id: "a",
      model: models.get("a"),
      props: { id: "a", label: "First" },
      scope: appScope,
    });
    expect(mounted[1]).toMatchObject({
      id: "b",
      model: models.get("b"),
      props: { id: "b", label: "Second" },
      scope: appScope,
    });

    scoped(appScope, () => {
      showFirst.value = false;
    });
    expect(unmounted.map(({ id }) => id)).toEqual(["a"]);
    expect(unmounted[0]).toMatchObject({
      id: "a",
      model: models.get("a"),
      props: { id: "a", label: "First" },
      scope: appScope,
    });
    expect(root.querySelector('[data-id="b"]')?.textContent).toBe("Second");
  });

  it("fires lifecycle events on every kept mount without rerunning setup or duplicating reactions", () => {
    const appScope = scope();
    const root = container();
    const visible = store(true);
    const setup = vi.fn();
    const mounts = vi.fn();
    const unmounts = vi.fn();
    const Counter = component(
      (props: { id: string }, { mounted, unmounted }) => {
        setup();
        const count = store(0);
        reaction({ on: mounted, run: mounts });
        reaction({ on: unmounted, run: unmounts });
        return h("button", { onClick: () => count.value++ }, () => count.value);
      },
      { keep: true },
    );

    attach(
      () => h(Show, { when: () => visible.value }, h(Counter, { id: "counter" })),
      root,
      appScope,
    );
    root.querySelector("button")!.click();
    scoped(appScope, () => {
      visible.value = false;
    });
    expect(mounts).toHaveBeenCalledTimes(1);
    expect(unmounts).toHaveBeenCalledTimes(1);
    scoped(appScope, () => {
      visible.value = true;
    });
    expect(root.querySelector("button")?.textContent).toBe("1");
    expect(setup).toHaveBeenCalledTimes(1);
    expect(mounts).toHaveBeenCalledTimes(2);
    expect(unmounts).toHaveBeenCalledTimes(1);
  });

  it("skips lifecycle events on the server and fires mounted after hydration claims DOM", () => {
    const serverScope = scope();
    const clientScope = scope();
    const observed: Array<{ id: string; node: Element | null; connected: boolean }> = [];
    const unmounted = vi.fn();
    const Card = component(
      (props: { id: string }, { mounted, unmounted: onUnmounted }) => {
        reaction({
          on: mounted,
          run(payload) {
            const node = document.querySelector("button");
            observed.push({ id: payload.id, node, connected: node?.isConnected ?? false });
          },
        });
        reaction({ on: onUnmounted, run: unmounted });
        return h("button", null, props.id);
      },
      { keep: true },
    );
    const view = () => h(Card, { id: "card" });
    const html = renderToString(view, { scope: serverScope });
    expect(observed).toEqual([]);
    expect(unmounted).not.toHaveBeenCalled();

    const root = container(html);
    const button = root.querySelector("button")!;
    const dispose = hydrate(view, root, { scope: clientScope });
    disposers.push(dispose);
    expect(root.querySelector("button")).toBe(button);
    expect(observed).toEqual([{ id: "card", node: button, connected: true }]);
    dispose();
    expect(unmounted).toHaveBeenCalledTimes(1);
  });

  it("emits outgoing props in unmounted during a same-id Show handoff", () => {
    const appScope = scope();
    const root = container();
    const showOld = store(true);
    const seen: Array<{ id: string; label: string; model: object }> = [];
    const setup = vi.fn();
    const Shared = component(
      (props: { id: string; label: string }, { unmounted }) => {
        setup();
        reaction({
          on: unmounted,
          run(payload) {
            seen.push({ id: payload.id, label: payload.props.label, model: payload.model });
          },
        });
        return h("span", null, () => props.label);
      },
      { keep: true },
    );
    const oldView = h(Shared, { id: "shared", label: "old" });
    const newView = h(Shared, { id: "shared", label: "new" });

    attach(
      () => h(Show, { when: () => showOld.value, fallback: newView }, oldView),
      root,
      appScope,
    );
    const model = collection(Shared.model, appScope).get("shared");
    scoped(appScope, () => {
      showOld.value = false;
    });
    expect(seen).toEqual([{ id: "shared", label: "old", model }]);
    expect(root.querySelector("span")?.textContent).toBe("new");
    expect(setup).toHaveBeenCalledTimes(1);
  });
});
