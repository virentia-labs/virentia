// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getOwner,
  reaction,
  scope,
  scoped,
  serialize,
  store,
  type Scope,
  type ScopeSnapshot,
} from "@virentia/core";
import { setActiveScope } from "@virentia/core/internal";
import {
  createContext,
  createElement as h,
  For,
  Fragment,
  Portal,
  Show,
  useContext,
  useId,
  useScope,
  type Child,
} from "../lib";
import { onMount, onUnmount } from "../lib/runtime";
import { renderToStaticMarkup, renderToString, serializeState } from "../lib/server";

afterEach(() => {
  setActiveScope(null);
});

describe("server rendering without a DOM", () => {
  it("marks every text boundary, including empty and adjacent text", () => {
    expect(typeof document).toBe("undefined");
    const view = () =>
      h(
        "p",
        null,
        "a",
        "",
        "b",
        () => undefined,
        () => null,
        0,
        2n,
        false,
      );
    expect(renderToString(view)).toBe(
      "<p><!--ui--><!--ui:t-->a<!--ui:t--><!--ui:t-->b<!--ui--><!--/ui--><!--ui--><!--/ui--><!--ui:t-->0<!--ui:t-->2<!--/ui--></p>",
    );
    expect(renderToStaticMarkup(view)).toBe("<p>ab02</p>");
  });

  it("escapes text, attributes and carriage returns and excludes event/ref values", () => {
    const ref = vi.fn();
    const html = renderToStaticMarkup(() =>
      h(
        "div",
        {
          title: '<script a="x">&\'\r',
          "data-value": false,
          onClick: vi.fn(),
          onclick: "unsafe()",
          ONLOAD: "unsafe()",
          ref,
          key: "secret-key",
        },
        '<script>&"\r',
      ),
    );
    expect(html).toBe(
      '<div title="&lt;script a=&quot;x&quot;&gt;&amp;&#39;&#13;" data-value="false">&lt;script&gt;&amp;"&#13;</div>',
    );
    expect(ref).not.toHaveBeenCalled();
  });

  it("serializes boolean attributes, class overlays, CSS and SVG names", () => {
    const html = renderToStaticMarkup(() =>
      h(
        "div",
        {
          classList: { off: false, active: true },
          className: "base off",
          hidden: false,
          inert: true,
          style: { backgroundColor: "red", "--tone": "warm", opacity: 0.5, width: null },
        },
        h(
          "svg",
          { viewBox: "0 0 10 10" },
          h("circle", { cx: 5, strokeWidth: 2, fillOpacity: 0.5 }),
        ),
      ),
    );
    expect(html).toBe(
      '<div class="base active" inert style="background-color:red;--tone:warm;opacity:0.5"><svg viewBox="0 0 10 10"><circle cx="5" stroke-width="2" fill-opacity="0.5"></circle></svg></div>',
    );
  });

  it("skips client lifecycle hooks and stops owned reactions after rendering", () => {
    const requestScope = scope();
    const count = store(0);
    const mounted = vi.fn();
    const unmounted = vi.fn();
    const observed = vi.fn();
    function App() {
      onMount(mounted);
      onUnmount(unmounted);
      reaction({
        scope: useScope(),
        run() {
          observed(count.value);
        },
      });
      return h("p", null, "server");
    }
    expect(renderToStaticMarkup(() => h(App, null), { scope: requestScope })).toBe("<p>server</p>");
    expect(mounted).not.toHaveBeenCalled();
    expect(unmounted).not.toHaveBeenCalled();
    expect(observed).toHaveBeenCalledTimes(1);
    expect(observed).toHaveBeenCalledWith(0);
    scoped(requestScope, () => {
      count.value = 1;
    });
    expect(observed).toHaveBeenCalledTimes(1);
  });

  it("cleans all owners after a failure and preserves both rendering and cleanup errors", () => {
    const completed = vi.fn();
    const unmounted = vi.fn();
    function App(): never {
      onUnmount(unmounted);
      getOwner()!.onCleanup(completed);
      getOwner()!.onCleanup(() => {
        throw new Error("cleanup error");
      });
      throw new Error("render error");
    }
    let thrown: unknown;
    try {
      renderToString(() => h(App, null));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).errors[0]).toHaveProperty("message", "render error");
    expect(completed).toHaveBeenCalledTimes(1);
    expect(unmounted).not.toHaveBeenCalled();
  });

  it("creates an isolated request scope even when called inside an ambient scope", () => {
    const count = store(0);
    const ambient = scope({ values: [[count, 99]] });
    const requests: Scope[] = [];
    const view = () => {
      requests.push(useScope());
      count.value += 1;
      return count.value;
    };
    expect(scoped(ambient, () => renderToStaticMarkup(view))).toBe("1");
    expect(scoped(ambient, () => renderToStaticMarkup(view))).toBe("1");
    expect(requests[0]).not.toBe(requests[1]);
    expect(requests).not.toContain(ambient);
    expect(scoped(ambient, () => count.value)).toBe(99);
  });

  it("uses explicit request snapshots and materializes only the consumed store state", () => {
    const count = store(0, undefined, { sid: "count" });
    const first = scope({ snapshot: { count: 7 } });
    const second = scope({ snapshot: { count: 12 } });
    const view = () => h("span", null, () => count.value);
    expect(renderToStaticMarkup(view, { scope: first })).toBe("<span>7</span>");
    expect(renderToStaticMarkup(view, { scope: second })).toBe("<span>12</span>");
    expect(serialize(first)).toEqual({ count: 7 });
    expect(serialize(second)).toEqual({ count: 12 });
  });

  it("preserves nested context, fragments, conditional branches and keyed row accessors", () => {
    const Theme = createContext("light");
    function Label() {
      const theme = useContext(Theme);
      return h("strong", null, theme);
    }
    const view = () =>
      h(
        Theme.Provider,
        { value: "dark" },
        h(
          Fragment,
          null,
          h(Show, { when: true, children: h(Label, null), fallback: "wrong" }),
          h(For<string>, {
            each: ["a", "b"],
            children: (item, index) => h("i", null, item, index),
          }),
          h(For<string>, { each: [], children: () => "wrong", fallback: "empty" }),
        ),
      );
    expect(renderToStaticMarkup(view)).toBe("<strong>dark</strong><i>a0</i><i>b1</i>empty");
    expect(renderToStaticMarkup(() => h(Label, null))).toBe("<strong>light</strong>");
    expect(() =>
      renderToString(() => h(For<number>, { each: [1, 1], children: () => null })),
    ).toThrow("unique keys");
  });

  it("keeps component IDs and local store SIDs stable across requests and repeated instances", () => {
    const ids: string[] = [];
    function Counter() {
      const count = store(1, undefined, { sid: "local-count" });
      const id = useId();
      ids.push(id);
      return h("button", { id }, () => count.value);
    }
    const view = () => h("main", null, h(Counter, null), h(Counter, null));
    const first = scope();
    const second = scope();
    expect(renderToString(view, { scope: first, identifierPrefix: "a b" })).toBe(
      renderToString(view, { scope: second, identifierPrefix: "a b" }),
    );
    expect(ids.slice(0, 2)).toEqual(ids.slice(2));
    expect(new Set(ids.slice(0, 2)).size).toBe(2);
    expect(ids[0]).toContain("ui:a%20b.");
    expect(serialize(first)).toEqual(serialize(second));
    expect(Object.keys(serialize(first))).toHaveLength(2);
    expect(Object.values(serialize(first))).toEqual([1, 1]);
  });

  it("renders native controlled and default form values before hydration", () => {
    const html = renderToStaticMarkup(() =>
      h(
        "form",
        null,
        h("input", { defaultValue: "draft", defaultChecked: true, disabled: false }),
        h("input", {
          value: "controlled",
          defaultValue: "ignored",
          checked: false,
          defaultChecked: true,
        }),
        h("textarea", { value: "\nfirst\r<&", defaultValue: "ignored" }),
        h(
          "select",
          { value: "two" },
          h("option", { value: "one" }, "One"),
          h("option", null, " two "),
        ),
        h(
          "select",
          { multiple: true, value: ["a", "c"] },
          ["a", "b", "c"].map((value) => h("option", { value }, value)),
        ),
      ),
    );
    expect(html).toBe(
      '<form><input value="draft" checked><input value="controlled"><textarea>\n\nfirst&#13;&lt;&amp;</textarea><select><option value="one">One</option><option selected> two </option></select><select multiple><option value="a" selected>a</option><option value="b">b</option><option value="c" selected>c</option></select></form>',
    );
  });

  it("keeps marker-free text elements safe and protects parser-sensitive leading newlines", () => {
    expect(renderToString(() => h("title", null, ["<&", () => "title"]))).toBe(
      "<title>&lt;&amp;title</title>",
    );
    expect(renderToStaticMarkup(() => h("pre", null, "\nfirst"))).toBe("<pre>\n\nfirst</pre>");
    expect(renderToString(() => h("script", { src: "/asset.js" }))).toBe(
      '<script src="/asset.js"></script>',
    );
    expect(() => renderToString(() => h("script", null, "alert(1)"))).toThrow("Inline <script>");
    expect(() => renderToString(() => h("style", null, "body {}"))).toThrow("Inline <style>");
    expect(() => renderToString(() => h("textarea", null, h("b", null)))).toThrow("Raw-text");
    expect(() => renderToString(() => h("input", null, "child"))).toThrow("Void element");
  });

  it("rejects unsafe names, innerHTML, native nodes, asynchronous children and server portals", () => {
    expect(() => renderToString(() => h("div><script", null))).toThrow("Invalid tag name");
    expect(() => renderToString(() => h("div", { 'x" onclick="': "bad" }))).toThrow(
      "Invalid attribute name",
    );
    expect(() => renderToString(() => h("div", { innerHTML: "raw" }))).toThrow(
      "owned DOM children",
    );
    expect(() => renderToString(() => ({ nodeType: 1 }) as unknown as Child)).toThrow(
      "Native DOM nodes",
    );
    expect(() => renderToString(() => Promise.resolve("later") as unknown as Child)).toThrow(
      "Async children",
    );
    expect(() => renderToString(() => h(Portal, { mount: {} as Element }))).toThrow(
      "Portal has no server transport",
    );
  });

  it("serializes snapshots without closing an inline script or changing JSON data", () => {
    const snapshot = JSON.parse(
      '{"__proto__":{"name":"safe"},"message":"</script><script>&"}',
    ) as ScopeSnapshot;
    snapshot.separator = "line\u2028paragraph\u2029";
    const output = serializeState(snapshot);
    expect(output).not.toMatch(/[<>&\u2028\u2029]/);
    expect(JSON.parse(output)).toEqual(snapshot);
    expect(output).toContain("\\u003c/script\\u003e");
  });
});
