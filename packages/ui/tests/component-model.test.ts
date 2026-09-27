// @vitest-environment happy-dom

import { reaction, scope, scoped, serialize, setErrorReporter, store, type Scope } from "@virentia/core";
import { setActiveScope } from "@virentia/core/internal";
import { collection } from "@virentia/core/models";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  action,
  component,
  createContext,
  createElement as h,
  For,
  hydrate,
  render,
  Show,
  type Child,
  useId,
  useContext,
  useScope,
} from "../lib";
import { componentMetadataOf } from "../lib/component";
import { onMount, onUnmount } from "../lib/runtime";
import { renderToString } from "../lib/server";

const mounted: Array<() => void> = [];

afterEach(() => {
  for (const dispose of mounted.splice(0).reverse()) dispose();
  document.body.textContent = "";
  setActiveScope(null);
  setErrorReporter(null);
});

function container(html = ""): HTMLDivElement {
  const element = document.createElement("div");
  element.innerHTML = html;
  document.body.append(element);
  return element;
}

function attach(
  factory: Parameters<typeof render>[0],
  target: HTMLDivElement,
  appScope: Scope,
  identifierPrefix?: string,
) {
  const dispose = render(factory, target, { scope: appScope, identifierPrefix });
  mounted.push(dispose);
  return dispose;
}

describe("staticModel-backed UI components", () => {
  it("gives ordinary function components a model and a stable automatic instance id", () => {
    const appScope = scope();
    const target = container();
    const Plain = () => h("span", null, "plain");
    const model = componentMetadataOf(Plain).model;

    const firstDispose = attach(() => h(Plain), target, appScope, "automatic");
    const firstId = collection(model, appScope).ids[0];
    expect(firstId).toMatch(/^ui:automatic/);
    expect(collection(model, appScope).get(firstId!)).not.toBeNull();

    firstDispose();
    expect(collection(model, appScope).get(firstId!)).toBeNull();
    attach(() => h(Plain), target, appScope, "automatic");
    expect(collection(model, appScope).ids).toEqual([firstId]);
  });

  it("prefers the explicit id prop over the component id derivation", () => {
    const appScope = scope();
    const target = container();
    const Label = component(
      (props: { id?: string; item: string }) => h("span", null, props.item),
      { id: (props) => `configured:${props.item}` },
    );

    attach(
      () =>
        h(
          "div",
          null,
          h(Label, { id: "explicit", item: "first" }),
          h(Label, { item: "second" }),
        ),
      target,
      appScope,
    );

    const models = collection(Label.model, appScope);
    expect(models.get("explicit")).not.toBeNull();
    expect(models.get("configured:second")).not.toBeNull();
    expect(models.get("configured:first")).toBeNull();
    expect(models.ids).toEqual(["explicit", "configured:second"]);
  });

  it("disposes an unmounted model by default even when its id was explicit", () => {
    const appScope = scope();
    const target = container();
    const visible = store(true);
    const setup = vi.fn();
    const Child = component((props: { id: string }) => {
      setup();
      const count = store(0);
      return h("button", { onClick: () => count.value++ }, () => count.value);
    });

    attach(
      () => h(Show, { when: () => visible.value }, h(Child, { id: "same" })),
      target,
      appScope,
    );
    target.querySelector("button")!.click();
    expect(target.textContent).toBe("1");
    expect(collection(Child.model, appScope).get("same")).not.toBeNull();

    scoped(appScope, () => {
      visible.value = false;
    });
    expect(collection(Child.model, appScope).get("same")).toBeNull();
    scoped(appScope, () => {
      visible.value = true;
    });
    expect(target.textContent).toBe("0");
    expect(setup).toHaveBeenCalledTimes(2);
  });

  it("keeps setup, store and action by id while remounting DOM and lifecycle hooks", () => {
    const appScope = scope();
    const target = container();
    const visible = store(true);
    const setup = vi.fn();
    const lifecycle: string[] = [];
    const Counter = component(
      (props: { id: string; label: string }) => {
        setup();
        const count = store(0, undefined, { sid: "counter-local" });
        const increment = action(() => {
          count.value++;
        });
        onMount(() => {
          lifecycle.push("mount");
          return () => lifecycle.push("mount-cleanup");
        });
        onUnmount(() => lifecycle.push("unmount"));
        return h("button", { onClick: increment }, () => `${props.label}:${count.value}`);
      },
      { keep: true },
    );

    const view = (label: string) =>
      h(Show, { when: () => visible.value }, h(Counter, { id: "counter", label }));
    attach(() => view("first"), target, appScope);
    const model = collection(Counter.model, appScope).get("counter");
    const firstButton = target.querySelector("button")!;
    firstButton.click();
    expect(firstButton.textContent).toBe("first:1");
    expect(lifecycle).toEqual(["mount"]);

    scoped(appScope, () => {
      visible.value = false;
    });
    expect(target.querySelector("button")).toBeNull();
    expect(collection(Counter.model, appScope).get("counter")).toBe(model);
    expect(lifecycle).toContain("unmount");
    expect(lifecycle).toContain("mount-cleanup");

    scoped(appScope, () => {
      visible.value = true;
    });
    const secondButton = target.querySelector("button")!;
    expect(secondButton).not.toBe(firstButton);
    expect(secondButton.textContent).toBe("first:1");
    secondButton.click();
    expect(secondButton.textContent).toBe("first:2");
    expect(setup).toHaveBeenCalledTimes(1);
    expect(lifecycle.filter((event) => event === "mount")).toHaveLength(2);
  });

  it("reuses a kept model with an automatic id after a Show branch remounts", () => {
    const appScope = scope();
    const target = container();
    const visible = store(true);
    const setup = vi.fn();
    const Counter = component(
      () => {
        setup();
        const count = store(0);
        return h("button", { onClick: () => count.value++ }, () => count.value);
      },
      { keep: true },
    );

    attach(
      () => h(Show, { when: () => visible.value }, h(Counter)),
      target,
      appScope,
    );
    const models = collection(Counter.model, appScope);
    const firstId = models.ids[0];
    target.querySelector("button")!.click();
    scoped(appScope, () => {
      visible.value = false;
      visible.value = true;
    });

    expect(models.ids).toEqual([firstId]);
    expect(target.textContent).toBe("1");
    expect(setup).toHaveBeenCalledTimes(1);
  });

  it("reuses an automatically identified kept model when a keyed For row returns", () => {
    const appScope = scope();
    const target = container();
    const items = store(["a", "b"]);
    const setup = vi.fn();
    const Row = component(
      (props: { item: () => string }) => {
        setup(props.item());
        const count = store(0);
        return h(
          "button",
          {
            "data-row": props.item(),
            onClick: () => count.value++,
          },
          () => `${props.item()}:${count.value}`,
        );
      },
      { keep: true },
    );

    attach(
      () =>
        h(For<string>, {
          each: () => items.value,
          children: (item) => h(Row, { item }),
        }),
      target,
      appScope,
    );
    const models = collection(Row.model, appScope);
    const firstIds = models.ids;
    target.querySelector<HTMLButtonElement>('[data-row="a"]')!.click();
    scoped(appScope, () => {
      items.value = ["b"];
    });
    scoped(appScope, () => {
      items.value = ["b", "a"];
    });

    expect(models.ids).toEqual(firstIds);
    expect(target.querySelector('[data-row="a"]')?.textContent).toBe("a:1");
    expect(setup.mock.calls).toEqual([["a"], ["b"]]);
  });

  it("passes new props to a kept setup without running that setup again", () => {
    const appScope = scope();
    const target = container();
    const setup = vi.fn();
    const Label = component(
      (props: { id: string; value: string }) => {
        setup();
        return h("span", null, () => props.value);
      },
      { keep: true },
    );

    const firstDispose = attach(() => h(Label, { id: "label", value: "old" }), target, appScope);
    const firstSpan = target.querySelector("span")!;
    firstDispose();
    attach(() => h(Label, { id: "label", value: "new" }), target, appScope);
    expect(target.querySelector("span")).not.toBe(firstSpan);
    expect(target.textContent).toBe("new");
    expect(setup).toHaveBeenCalledTimes(1);
  });

  it.each(["Show", "dynamic"])(
    "atomically hands off a retained model with the same id between %s branches",
    (kind) => {
      const appScope = scope();
      const target = container();
      const oldBranch = store(true);
      const setup = vi.fn();
      const Shared = component(
        (props: { id: string; label: string }) => {
          setup();
          const count = store(0);
          return h("button", { onClick: () => count.value++ }, () => `${props.label}:${count.value}`);
        },
        { keep: true },
      );
      const oldView = h(Shared, { id: "same", label: "old" });
      const newView = h(Shared, { id: "same", label: "new" });
      const view = () =>
        kind === "Show"
          ? h(Show, { when: () => oldBranch.value, fallback: newView }, oldView)
          : () => (oldBranch.value ? oldView : newView);

      attach(view, target, appScope);
      const firstButton = target.querySelector("button")!;
      firstButton.click();
      const firstModel = collection(Shared.model, appScope).get("same");
      scoped(appScope, () => {
        oldBranch.value = false;
      });

      const secondButton = target.querySelector("button")!;
      expect(secondButton).not.toBe(firstButton);
      expect(secondButton.textContent).toBe("new:1");
      expect(collection(Shared.model, appScope).get("same")).toBe(firstModel);
      secondButton.click();
      expect(secondButton.textContent).toBe("new:2");
      expect(setup).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["Show", "dynamic"])(
    "keeps the old %s branch and model usable if a replacement mount fails",
    (kind) => {
      const appScope = scope();
      const target = container();
      const oldBranch = store(true);
      const report = vi.fn();
      setErrorReporter(report);
      const setup = vi.fn();
      const Shared = component(
        (props: { id: string; label: string }) => {
          setup();
          const count = store(0);
          return h("button", { onClick: () => count.value++ }, () => `${props.label}:${count.value}`);
        },
        { keep: true },
      );
      function Broken(): never {
        throw new Error("replacement setup failed");
      }
      const oldView = h(Shared, { id: "same", label: "old" });
      const brokenView = h(
        "section",
        null,
        h(Shared, { id: "same", label: "new" }),
        h(Broken),
      );
      const view = () =>
        kind === "Show"
          ? h(Show, { when: () => oldBranch.value, fallback: brokenView }, oldView)
          : () => (oldBranch.value ? oldView : brokenView);

      attach(view, target, appScope);
      const oldButton = target.querySelector("button")!;
      const model = collection(Shared.model, appScope).get("same");
      scoped(appScope, () => {
        oldBranch.value = false;
      });

      expect(report).toHaveBeenCalled();
      expect(target.querySelector("button")).toBe(oldButton);
      expect(target.querySelector("section")).toBeNull();
      expect(collection(Shared.model, appScope).get("same")).toBe(model);
      oldButton.click();
      expect(oldButton.textContent).toBe("old:1");
      expect(setup).toHaveBeenCalledTimes(1);
    },
  );

  it("gives old onUnmount callbacks the outgoing props and context during a kept Show handoff", () => {
    const appScope = scope();
    const target = container();
    const showOld = store(true);
    const Theme = createContext("default");
    const unmounted: string[] = [];
    const setup = vi.fn();
    const Shared = component(
      (props: { id: string; label: string }) => {
        setup();
        const theme = useContext(Theme);
        onUnmount(() => unmounted.push(`${props.label}/${theme()}`));
        return h("span", null, () => `${props.label}/${theme()}`);
      },
      { keep: true },
    );
    const oldView = h(
      Theme.Provider,
      { value: "old" },
      h(Shared, { id: "same", label: "old" }),
    );
    const newView = h(
      Theme.Provider,
      { value: "new" },
      h(Shared, { id: "same", label: "new" }),
    );

    attach(
      () => h(Show, { when: () => showOld.value, fallback: newView }, oldView),
      target,
      appScope,
    );
    scoped(appScope, () => {
      showOld.value = false;
    });

    expect(unmounted).toEqual(["old/old"]);
    expect(target.querySelector("span")?.textContent).toBe("new/new");
    expect(setup).toHaveBeenCalledTimes(1);
  });

  it("disposes an uncommitted kept model and setup reaction after an unsupported child", () => {
    const appScope = scope();
    const target = container();
    const tracked = store(0);
    const read = vi.fn(() => tracked.value);
    const Broken = component((_props: { id: string }) => {
      reaction({ scope: useScope(), run: read });
      return { unsupported: true } as unknown as Child;
    }, { keep: true });

    expect(() => render(() => h(Broken, { id: "failed" }), target, { scope: appScope }))
      .toThrow(/Unsupported child/);
    expect(collection(Broken.model, appScope).get("failed")).toBeNull();
    expect(target.childNodes).toHaveLength(0);
    scoped(appScope, () => {
      tracked.value++;
    });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("disposes an uncommitted kept model and setup reaction after a hydration mismatch", () => {
    const appScope = scope();
    const target = container(renderToString(() => h("span", null, "server")));
    const originalHtml = target.innerHTML;
    const tracked = store(0);
    const read = vi.fn(() => tracked.value);
    const Client = component((_props: { id: string }) => {
      reaction({ scope: useScope(), run: read });
      return h("button", null, "client");
    }, { keep: true });

    expect(() => hydrate(() => h(Client, { id: "failed" }), target, { scope: appScope }))
      .toThrow(/Hydration mismatch/);
    expect(collection(Client.model, appScope).get("failed")).toBeNull();
    expect(target.innerHTML).toBe(originalHtml);
    scoped(appScope, () => {
      tracked.value++;
    });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("releases a non-kept component's local SID when its Show branch unmounts", () => {
    const appScope = scope();
    const target = container();
    const visible = store(true);
    const report = vi.fn();
    setErrorReporter(report);
    const setup = vi.fn();
    const Counter = component(() => {
      setup();
      const count = store(0, undefined, { sid: "local-counter" });
      return h("button", { onClick: () => count.value++ }, () => count.value);
    });

    attach(() => h(Show, { when: () => visible.value }, h(Counter)), target, appScope);
    target.querySelector("button")!.click();
    expect(target.textContent).toBe("1");
    scoped(appScope, () => {
      visible.value = false;
    });
    scoped(appScope, () => {
      visible.value = true;
    });

    expect(report).not.toHaveBeenCalled();
    expect(target.querySelector("button")?.textContent).toBe("0");
    expect(setup).toHaveBeenCalledTimes(2);
  });

  it("rejects two simultaneously mounted instances with the same component id", () => {
    const appScope = scope();
    const target = container();
    const Child = component((_props: { id: string }) => h("span", null, "child"), {
      keep: true,
    });

    expect(() =>
      render(
        () => h("div", null, h(Child, { id: "duplicate" }), h(Child, { id: "duplicate" })),
        target,
        { scope: appScope },
      ),
    ).toThrow(/already mounted/);
    expect(target.childNodes).toHaveLength(0);
  });

  it("uses the same model ids, local SIDs and useId values in SSR and hydration", () => {
    const Counter = component(
      (_props: { id: string }) => {
        const count = store(3, undefined, { sid: "ssr-counter-local" });
        const domId = useId();
        return h("button", { id: domId, onClick: () => count.value++ }, () => count.value);
      },
      { keep: true },
    );
    const serverScope = scope();
    const view = () => h(Counter, { id: "counter" });
    const html = renderToString(view, { scope: serverScope, identifierPrefix: "hydrated" });
    const snapshot = serialize(serverScope);
    expect(Object.keys(snapshot)).toHaveLength(1);
    expect(collection(Counter.model, serverScope).get("counter")).not.toBeNull();

    const target = container(html);
    const button = target.querySelector("button")!;
    const clientScope = scope({ snapshot });
    const dispose = hydrate(view, target, {
      scope: clientScope,
      identifierPrefix: "hydrated",
    });
    mounted.push(dispose);
    expect(target.querySelector("button")).toBe(button);
    expect(button.id).toBeTruthy();
    expect(button.textContent).toBe("3");
    expect(collection(Counter.model, clientScope).get("counter")).not.toBeNull();
    button.click();
    expect(button.textContent).toBe("4");
  });
});
