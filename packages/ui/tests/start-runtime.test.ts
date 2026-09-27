// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { getCurrentScope, scoped, store } from "@virentia/core";
import { createElement as h, useId } from "../lib";
import { foreignTree } from "../lib/runtime";
import { hydratePage, renderPage, renderPageAsync } from "../start/runtime";

const disposers: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposers.splice(0).reverse()) dispose();
  document.body.textContent = "";
});

describe("start runtime", () => {
  it("restores request state and data while retaining the server DOM", () => {
    let initialCount = 7;
    const label = "</script><script>alert(1)</script>&\u2028\u2029";
    function view(data: { label: string }) {
      const count = store(initialCount, undefined, { sid: "start/count" });
      const id = useId();
      return h(
        "button",
        {
          id,
          title: data.label,
          onClick: () => {
            count.value++;
          },
        },
        () => count.value,
      );
    }

    const first = renderPage(view, { label }, { identifierPrefix: "page" });
    expect(first.payload).not.toMatch(/[<>&\u2028\u2029]/);
    expect(JSON.parse(first.payload).data).toEqual({ label });
    expect(Object.values(JSON.parse(first.payload).snapshot)).toEqual([7]);

    initialCount = 9;
    const second = renderPage(view, { label }, { identifierPrefix: "page" });
    expect(Object.values(JSON.parse(second.payload).snapshot)).toEqual([9]);

    const container = document.createElement("div");
    container.innerHTML = first.html;
    document.body.append(container);
    const button = container.querySelector("button")!;
    const id = button.id;
    initialCount = 99;

    const hydrated = hydratePage(view, container, first.payload);
    disposers.push(hydrated.dispose);
    expect(hydrated.data).toEqual({ label });
    expect(container.querySelector("button")).toBe(button);
    expect(button.id).toBe(id);
    expect(button.title).toBe(label);
    expect(button.textContent).toBe("7");
    button.click();
    expect(button.textContent).toBe("8");
  });

  it("rejects data that cannot round-trip through JSON", () => {
    const render = (data: unknown) => renderPage(() => null, data, { identifierPrefix: "page" });
    expect(() => render({ missing: undefined })).toThrow(/unsupported undefined/);
    expect(() => render({ bad: Number.NaN })).toThrow(/unsupported number/);
    expect(() => render(new Date())).toThrow(/plain JSON object/);
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => render(cyclic)).toThrow(/cyclic value/);
  });

  it("isolates overlapping async requests and snapshots stores read after an await", async () => {
    const count = store(0, undefined, { sid: "start/async-count" });
    const gates = new Map<number, () => void>();
    const view = (data: { count: number }) =>
      h(
        "main",
        null,
        foreignTree({
          node: data.count,
          asyncServerRender: true,
          async serverRender(value, requestScope) {
            await new Promise<void>((resolve) => gates.set(value, resolve));
            return scoped(requestScope, () => {
              count.value = value;
              return `<b>${count.value}</b>`;
            });
          },
          mount: () => ({ update() {}, dispose() {} }),
        }),
      );

    const input = { count: 3 };
    const first = renderPageAsync(view, input, { identifierPrefix: "page" });
    input.count = 99;
    const second = renderPageAsync(view, { count: 7 }, { identifierPrefix: "page" });
    expect(getCurrentScope()).toBeNull();
    await vi.waitFor(() => expect(gates.size).toBe(2));
    expect(getCurrentScope()).toBeNull();
    gates.get(7)!();
    const secondPage = await second;
    expect(secondPage.html).toContain("<b>7</b>");
    expect(JSON.parse(secondPage.payload)).toMatchObject({
      data: { count: 7 },
      snapshot: { "start/async-count": 7 },
    });
    expect(getCurrentScope()).toBeNull();
    gates.get(3)!();
    const firstPage = await first;
    expect(firstPage.html).toContain("<b>3</b>");
    expect(JSON.parse(firstPage.payload)).toMatchObject({
      data: { count: 3 },
      snapshot: { "start/async-count": 3 },
    });
    expect(getCurrentScope()).toBeNull();
  });

  it("uses the same JSON contract for async pages and propagates renderer failures", async () => {
    await expect(
      renderPageAsync(
        () => null,
        { invalid: undefined },
        {
          identifierPrefix: "page",
        },
      ),
    ).rejects.toThrow(/unsupported undefined/);
    await expect(
      renderPageAsync(
        () =>
          foreignTree({
            node: null,
            asyncServerRender: true,
            async serverRender() {
              await Promise.resolve();
              throw new Error("foreign SSR failed");
            },
            mount: () => ({ update() {}, dispose() {} }),
          }),
        null,
        { identifierPrefix: "page" },
      ),
    ).rejects.toThrow("foreign SSR failed");
    expect(getCurrentScope()).toBeNull();
  });

  it("rejects malformed client payloads before hydration", () => {
    const container = document.createElement("div");
    expect(() => hydratePage(() => null, container, "{}")).toThrow(/missing data/);
    expect(() =>
      hydratePage(() => null, container, '{"data":null,"identifierPrefix":"page"}'),
    ).toThrow(/snapshot must be a record/);
  });
});
