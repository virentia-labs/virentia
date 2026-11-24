// @vitest-environment node
import { reaction, scope, serialize, store } from "@virentia/core";
import { f, staticModel } from "@virentia/core/models";
import { collection } from "../../core/lib/models/collection";
import { describe, expect, it, vi } from "vitest";
import { action, component, h, Portal, ref, ui, type Child } from "../lib";
import { renderToStaticMarkup, renderToString, serializeState } from "../lib/server";

const markup = (view: () => Child) => renderToStaticMarkup(view, { scope: scope() });
const html = (view: () => Child) => renderToString(view, { scope: scope() });

describe("native server renderer", () => {
  it("requires an explicit request scope even when another scope is ambient", () => {
    expect(() => renderToString(() => "text", undefined as never)).toThrow("explicit scope");
    expect(typeof document).toBe("undefined");
  });
  it("marks empty, adjacent and scalar text boundaries for hydration, not static markup", () => {
    const count = store(3);
    const view = () => h("p", null, "a", "", "b", count, 0, 2n, false);
    expect(html(view)).toBe("<p><!--ui:t-->a<!--ui:t--><!--ui:t-->b<!--ui--><!--ui:t-->3<!--/ui--><!--ui:t-->0<!--ui:t-->2</p>");
    expect(markup(view)).toBe("<p>ab302</p>");
  });
  it("escapes attributes, text and carriage returns and omits event and ref units", () => {
    const clicked = action(() => {});
    const input = ref<HTMLDivElement>();
    expect(markup(() => h("div", { title: '<script a="x">&\'\r', "data-value": false, onClick: clicked, onclick: "unsafe()", ref: input },
      '<script>&"\r'))).toBe('<div title="&lt;script a=&quot;x&quot;&gt;&amp;&#39;&#13;" data-value="false">&lt;script&gt;&amp;"&#13;</div>');
  });
  it("serializes native boolean attributes, class overlays, CSS and SVG attribute names", () => {
    expect(markup(() => h("div", {
      classList: { off: false, active: true }, className: "base off", hidden: false, inert: true,
      style: { backgroundColor: "red", "--tone": "warm", opacity: 0.5, width: null },
    }, h("svg", { viewBox: "0 0 10 10" }, h("circle", { cx: 5, strokeWidth: 2, fillOpacity: 0.5 })))))
      .toBe('<div class="base active" inert style="background-color:red;--tone:warm;opacity:0.5"><svg viewBox="0 0 10 10"><circle cx="5" stroke-width="2" fill-opacity="0.5"></circle></svg></div>');
  });
  it("does not emit DOM lifecycle events or dispose the model before its snapshot", () => {
    const mounted = vi.fn(), unmounted = vi.fn();
    const Model = staticModel({ name: "ServerOnly", with: [ui], data: { count: f.number(1) }, setup(self) {
      reaction({ on: self.mounted, run: mounted }); reaction({ on: self.unmounted, run: unmounted });
    } });
    const View = component({ model: Model, view: (_props, self) => h("p", null, self.model.count) });
    const request = scope();
    expect(renderToStaticMarkup(() => h(View, { id: "one" }), { scope: request })).toBe("<p>1</p>");
    expect(mounted).not.toHaveBeenCalled(); expect(unmounted).not.toHaveBeenCalled();
    expect(collection(Model, request).get("one")!.alive).toBe(true);
    expect(Object.values(serialize(request))).toContain(1);
  });
  it("restores only consumed writable SID stores, independently per request", () => {
    const count = store(0, undefined, { sid: "count" });
    const a = scope({ snapshot: { count: 7 } }), b = scope({ snapshot: { count: 12 } });
    const view = () => h("span", null, count);
    expect(renderToStaticMarkup(view, { scope: a })).toBe("<span>7</span>");
    expect(renderToStaticMarkup(view, { scope: b })).toBe("<span>12</span>");
    expect(serialize(a)).toEqual({ count: 7 }); expect(serialize(b)).toEqual({ count: 12 });
  });
  it("renders controlled and default native form values before hydration", () => {
    expect(markup(() => h("form", null,
      h("input", { defaultValue: "draft", defaultChecked: true, disabled: false }),
      h("input", { value: "controlled", defaultValue: "ignored", checked: false, defaultChecked: true }),
      h("textarea", { value: "\nfirst\r<&", defaultValue: "ignored" }),
      h("select", { value: "two" }, h("option", { value: "one" }, "One"), h("option", null, " two ")),
      h("select", { multiple: true, value: ["a", "c"] }, ["a", "b", "c"].map((value) => h("option", { value }, value)))
    ))).toBe('<form><input value="draft" checked><input value="controlled"><textarea>\n\nfirst&#13;&lt;&amp;</textarea><select><option value="one">One</option><option selected> two </option></select><select multiple><option value="a" selected>a</option><option value="b">b</option><option value="c" selected>c</option></select></form>');
  });
  it("protects raw-text elements and parser-sensitive leading newlines", () => {
    expect(html(() => h("title", null, ["<&", () => "title"]))).toBe("<title>&lt;&amp;title</title>");
    expect(markup(() => h("pre", null, "\nfirst"))).toBe("<pre>\n\nfirst</pre>");
    expect(html(() => h("script", { src: "/asset.js" }))).toBe('<script src="/asset.js"></script>');
    expect(() => html(() => h("script", null, "alert(1)"))).toThrow("Inline <script>");
    expect(() => html(() => h("style", null, "body {}"))).toThrow("Inline <style>");
    expect(() => html(() => h("textarea", null, h("b")))).toThrow("Raw-text");
    expect(() => html(() => h("input", null, "child"))).toThrow("Void element");
  });
  it("rejects unsafe names, innerHTML, native DOM nodes, async children and server portals", () => {
    expect(() => html(() => h("div><script"))).toThrow("Invalid tag name");
    expect(() => html(() => h("div", { 'x" onclick="': "bad" }))).toThrow("Invalid attribute name");
    expect(() => html(() => h("div", { innerHTML: "raw" }))).toThrow("owned DOM children");
    expect(() => html(() => ({ nodeType: 1 }) as Child)).toThrow("Native DOM nodes");
    expect(() => html(() => Promise.resolve("later") as unknown as Child)).toThrow("Async children");
    expect(() => html(() => h(Portal, { mount: {} as Element }))).toThrow("Portal has no server transport");
  });
  it("escapes snapshots for an inline JSON script without changing the data", () => {
    const state = JSON.parse('{"__proto__":{"name":"safe"},"message":"</script><script>&"}');
    state.separator = "line\u2028paragraph\u2029";
    const output = serializeState(state);
    expect(output).not.toMatch(/[<>&\u2028\u2029]/);
    expect(JSON.parse(output)).toEqual(state);
  });
});
