import { getOwner, scope, store, type Owner } from "@virentia/core";
import {
  collectScopedNodes,
  getActiveScope,
  isTracking,
  resolveStoreSid,
  setActiveScope,
  setOwner,
  setSidScopeFrame,
} from "@virentia/core/internal";
import { expect, vi } from "vitest";
import { jsx } from "../lib/jsx-runtime";
import { render } from "../lib";
import { renderToString } from "../lib/server";
import { test } from "./support/vitest";

test("restores initial DOM property readers after nested mounts and caught read errors", async ({ root }) => {
  const nested = root.document.createElement("aside");
  const other = scope();
  const title = store("nested");
  let dispose: ReturnType<typeof render> | undefined;
  try {
    await root.render(() => jsx("p", {
      get title() {
        expect(() => render(() => jsx("span", {
          get "data-error"() { throw new Error("nested read"); },
        }), nested, { scope: other })).toThrow("nested read");
        dispose = render(() => jsx("span", {
          title, children: "nested content",
        }), nested, { scope: other });
        return "outer title";
      },
      "data-tail": "outer tail",
      children: "outer content",
    }));
    const paragraph = root.container.querySelector("p")!;
    expect(paragraph.title).toBe("outer title");
    expect(paragraph.getAttribute("data-tail")).toBe("outer tail");
    expect(paragraph.textContent).toBe("outer content");
    expect(nested.querySelector("span")!.title).toBe("nested");
    root.run(() => { title.value = "other scope"; });
    expect(nested.querySelector("span")!.title).toBe("nested");
  } finally {
    if (dispose) await dispose();
  }
  await root.render(() => jsx("p", {
    title: "after failure", "data-tail": "after tail", children: "after content",
  }));
  const paragraph = root.container.querySelector("p")!;
  expect(paragraph.title).toBe("after failure");
  expect(paragraph.getAttribute("data-tail")).toBe("after tail");
  expect(paragraph.textContent).toBe("after content");
});

test("keeps fused array coordinates identical in SSR and hydration", async ({ root }) => {
  let seen: string[] = [];
  const props = () => ({
    get title() { const sid = resolveStoreSid("probe")!; seen.push(sid); return sid; },
    children: "text",
  });
  const Helper = () => jsx("p", props());
  const tree = () => [jsx("p", props()), jsx(Helper, {}), [jsx("p", props())]];
  const html = renderToString(tree, { scope: scope(), identifierPrefix: "test" });
  expect(seen).toEqual([
    "ui:test.item:0.0/probe",
    "ui:test.item:1.0.0/probe",
    "ui:test.item:2.item:0.0/probe",
  ]);
  const expected = seen;
  seen = [];
  await root.hydrate(tree, html);
  expect(seen).toEqual(expected);
  expect([...root.container.querySelectorAll("p")].map(p => p.title)).toEqual(expected);
});

test("native attribute callbacks run outside dependency capture", async ({ root }) => {
  const incidental = store(0);
  const title = store("first");
  const tracking: boolean[] = [];
  let reads = 0;
  const createElement = root.document.createElement.bind(root.document);
  const spy = vi.spyOn(root.document, "createElement").mockImplementation((tag, options) => {
    const element = createElement(tag, options);
    if (tag === "section") {
      const setAttribute = element.setAttribute.bind(element);
      element.setAttribute = (name, value) => {
        tracking.push(isTracking());
        void incidental.value;
        setAttribute(name, value);
      };
    }
    return element;
  });
  try {
    await root.render(() => jsx("section", {
      "data-static": "static",
      get "data-title"() { reads++; return title.value; },
    }));
    const element = root.container.firstElementChild!;
    root.run(() => { incidental.value++; });
    expect(reads).toBe(1);
    root.run(() => { title.value = "next"; });
    expect(reads).toBe(2);
    expect(element.getAttribute("data-title")).toBe("next");
    expect(tracking).toEqual([false, false, false]);
  } finally {
    spy.mockRestore();
  }
});

test("native property reads do not replace an enclosing capture", async ({ root }) => {
  const outside = store(0);
  const title = store("first");
  const captured = root.run(() => collectScopedNodes(root.scope, () => {
    void outside.value;
    const mounted = root.render(() => jsx("p", { title, children: "text" }));
    void outside.value;
    return mounted;
  }));
  await captured.value;
  expect(captured.dependencies).toEqual(new Set([outside.node]));
  root.run(() => { title.value = "next"; });
  expect(root.container.firstElementChild!.getAttribute("title")).toBe("next");
});

test("restores the native children namespace after an attribute changes ambient frames", async ({
  root,
}) => {
  const other = scope();
  let owner: Owner | null = null;
  let sid = "";
  const before = { scope: getActiveScope(), owner: getOwner(), sid: resolveStoreSid("outside") };
  const View = () =>
    jsx("section", {
      get title() {
        owner = getOwner();
        sid = resolveStoreSid("probe")!;
        setActiveScope(other);
        setOwner(null);
        setSidScopeFrame("attribute-only");
        return "title";
      },
      get children() {
        expect(getActiveScope()).toBe(root.scope);
        expect(getOwner()).toBe(owner);
        expect(resolveStoreSid("probe")).toBe(sid);
        return "children";
      },
    });
  await root.render(() => jsx(View, {}));
  expect(root.container.textContent).toBe("children");
  expect(root.container.querySelector("section")!.title).toBe("title");
  expect({ scope: getActiveScope(), owner: getOwner(), sid: resolveStoreSid("outside") }).toEqual(
    before,
  );
});

test("finishes reactive shape bindings before reading native children", async ({ root }) => {
  const attributes = store({ title: "before" });
  let childrenReads = 0;
  const props = new Proxy(
    {},
    {
      ownKeys: () => [...Object.keys(attributes.value), "children"],
      getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
      get(_target, key) {
        if (key === "children") {
          childrenReads++;
          attributes.value = { title: "after" };
          return "content";
        }
        if (key === "title") return attributes.value.title;
      },
    },
  );
  const View = () => jsx("p", props);
  await root.render(() => jsx(View, {}));
  const element = root.container.querySelector("p")!;
  expect(element.title).toBe("after");
  expect(element.textContent).toBe("content");
  expect(childrenReads).toBe(1);
  root.run(() => {
    attributes.value = { title: "last" };
  });
  expect(element.title).toBe("last");
  expect(childrenReads).toBe(1);
});

test("does not turn a one-shot children getter into a prop shape dependency", async ({ root }) => {
  const source = store("first");
  let reads = 0;
  const View = () =>
    jsx("p", {
      get children() {
        reads++;
        return source.value;
      },
    });
  await root.render(() => jsx(View, {}));
  root.run(() => {
    source.value = "second";
  });
  expect(root.container.textContent).toBe("first");
  expect(reads).toBe(1);
});

test("rolls back DOM and all ambient frames when the children read throws", async ({ root }) => {
  const before = { scope: getActiveScope(), owner: getOwner(), sid: resolveStoreSid("outside") };
  const View = () =>
    jsx("p", {
      title: "title",
      get children() {
        setActiveScope(scope());
        setOwner(null);
        setSidScopeFrame("throwing-child");
        throw Error("children failed");
      },
    });
  await expect(root.render(() => jsx(View, {}))).rejects.toThrow("children failed");
  expect(root.container.childNodes).toHaveLength(0);
  expect({ scope: getActiveScope(), owner: getOwner(), sid: resolveStoreSid("outside") }).toEqual(
    before,
  );
});

for (const stage of ["shape", "property"]) {
  test(`restores a failed native ${stage} read before the next render`, async ({ root }) => {
    const other = scope();
    const before = { scope: getActiveScope(), owner: getOwner(), sid: resolveStoreSid("outside") };
    const fail = () => {
      setActiveScope(other);
      setOwner(null);
      setSidScopeFrame("failed-property");
      throw Error("property failed");
    };
    const props = new Proxy(
      { title: "title" },
      {
        ownKeys(target) {
          if (stage === "shape") fail();
          return Reflect.ownKeys(target);
        },
        get(target, key, receiver) {
          if (stage === "property" && key === "title") fail();
          return Reflect.get(target, key, receiver);
        },
      },
    );
    const View = () => jsx("p", props);
    await expect(root.render(() => jsx(View, {}))).rejects.toThrow("property failed");
    expect(root.container.childNodes).toHaveLength(0);
    expect({ scope: getActiveScope(), owner: getOwner(), sid: resolveStoreSid("outside") }).toEqual(
      before,
    );
    const title = store("first");
    await root.render(() => jsx("p", { title, children: "content" }));
    root.run(() => {
      title.value = "second";
    });
    expect(root.container.querySelector("p")!.title).toBe("second");
    expect(root.container.textContent).toBe("content");
  });
}
