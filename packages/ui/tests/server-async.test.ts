// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { getCurrentScope, getOwner, scope, scoped, store } from "@virentia/core";
import { createElement as h, foreignTree } from "../lib/runtime";
import { renderToString, renderToStringAsync, renderToStaticMarkupAsync } from "../lib/server";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const unusedMount = () => ({ update() {}, dispose() {} });

describe("asynchronous foreign SSR", () => {
  it("isolates overlapping request scopes and keeps foreign HTML opaque to substitution", async () => {
    const count = store(0);
    const first = deferred();
    const second = deferred();
    const view = (wait: Promise<void>) =>
      h(
        "main",
        null,
        "<!--ui:ssr:0-->",
        foreignTree({
          node: null,
          serverRender: () => "<!--ui:ssr:1--><b>sync</b>",
          mount: unusedMount,
        }),
        foreignTree({
          kind: "async",
          node: null,
          asyncServerRender: true,
          async serverRender(_node, requestScope) {
            await wait;
            return scoped(requestScope, () => `<strong>${count.value}</strong>`);
          },
          mount: unusedMount,
        }),
      );
    const a = renderToStringAsync(() => view(first.promise), {
      scope: scope({ values: [[count, 3]] }),
    });
    const b = renderToStringAsync(() => view(second.promise), {
      scope: scope({ values: [[count, 7]] }),
    });
    expect(getCurrentScope()).toBeNull();
    second.resolve();
    const secondHtml = await b;
    expect(secondHtml).toContain('<div data-ui-ssr="async"><strong>7</strong></div>');
    expect(secondHtml).toContain("&lt;!--ui:ssr:0--&gt;");
    expect(secondHtml).toContain("<!--ui:ssr:1--><b>sync</b>");
    first.resolve();
    expect(await a).toContain("<strong>3</strong>");
    expect(getCurrentScope()).toBeNull();
  });

  it("keeps all owners alive until started renderers settle after a native failure", async () => {
    const wait = deferred();
    const cleaned = vi.fn();
    const failure = new Error("native sibling failed");
    let settled = false;
    const rendered = renderToStringAsync(() => [
      foreignTree({
        node: null,
        asyncServerRender: true,
        async serverRender() {
          const owner = getOwner()!;
          owner.onCleanup(cleaned);
          await wait.promise;
          expect(owner.disposed).toBe(false);
          return "<p>done</p>";
        },
        mount: unusedMount,
      }),
      () => {
        throw failure;
      },
    ]);
    void rendered.catch(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(cleaned).not.toHaveBeenCalled();
    wait.resolve();
    await expect(rendered).rejects.toBe(failure);
    expect(cleaned).toHaveBeenCalledTimes(1);
    expect(getCurrentScope()).toBeNull();
  });

  it("awaits sibling work even when a foreign renderer rejects", async () => {
    const wait = deferred();
    const cleaned = vi.fn();
    const failure = new Error("foreign failed");
    const rendered = renderToStringAsync(() => [
      foreignTree({
        node: null,
        serverRender: async () => {
          throw failure;
        },
        mount: unusedMount,
      }),
      foreignTree({
        node: null,
        async serverRender() {
          getOwner()!.onCleanup(cleaned);
          await wait.promise;
          return "<p>settled</p>";
        },
        mount: unusedMount,
      }),
    ]);
    await Promise.resolve();
    expect(cleaned).not.toHaveBeenCalled();
    wait.resolve();
    await expect(rendered).rejects.toBe(failure);
    expect(cleaned).toHaveBeenCalledTimes(1);
  });

  it("rejects declared async renderers before starting work in synchronous SSR", () => {
    const serverRender = vi.fn(async () => "<p>async</p>");
    expect(() =>
      renderToString(() =>
        foreignTree({
          node: null,
          asyncServerRender: true,
          serverRender,
          mount: unusedMount,
        }),
      ),
    ).toThrow("requires renderToStringAsync()");
    expect(serverRender).not.toHaveBeenCalled();
  });

  it("awaits static markup without emitting native hydration markers", async () => {
    const html = await renderToStaticMarkupAsync(() =>
      h(
        "main",
        null,
        foreignTree({
          node: null,
          serverRender: async () => "<p>foreign</p>",
          mount: unusedMount,
        }),
      ),
    );
    expect(html).toBe("<main><div><p>foreign</p></div></main>");
  });
});
