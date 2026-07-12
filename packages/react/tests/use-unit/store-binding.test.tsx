// @vitest-environment happy-dom

import { event, reaction, scope, scoped, store } from "@virentia/core";
import { render, screen } from "@testing-library/react";
import { act, createElement } from "react";
import { describe, expect, it } from "vitest";
import { useUnit } from "../../lib";
import { resetAmbientScopeAfterEach } from "../support/ambient-scope-reset";
import { button, readIn, renderWithScope, withScope } from "../support/render-harness";

resetAmbientScopeAfterEach();

describe("useUnit (store binding)", () => {
  it("re-renders once per committed scoped write", async () => {
    const appScope = scope();
    const bump = event<void>();
    const count = store(0);
    reaction({ on: bump, run: () => (count.value += 1) });

    let renders = 0;
    function Counter() {
      renders += 1;
      const value = useUnit(count);
      return createElement("span", null, String(value));
    }

    renderWithScope(appScope, createElement(Counter));
    expect(screen.getByText("0")).toBeTruthy();
    const base = renders;

    await act(async () => {
      await scoped(appScope, () => bump());
    });

    expect(screen.getByText("1")).toBeTruthy();
    // Exactly one additional render for one committed write.
    expect(renders - base).toBe(1);
  });

  it("ignores a write committed in a foreign scope", async () => {
    const scopeA = scope();
    const scopeB = scope();
    const bump = event<void>();
    const count = store(0);
    reaction({ on: bump, run: () => (count.value += 1) });

    let renders = 0;
    function Counter() {
      renders += 1;
      return createElement("span", null, String(useUnit(count)));
    }

    renderWithScope(scopeA, createElement(Counter));
    const base = renders;
    expect(screen.getByText("0")).toBeTruthy();

    await act(async () => {
      await scoped(scopeB, () => bump());
    });

    // Bound component unchanged; no extra render.
    expect(screen.getByText("0")).toBeTruthy();
    expect(renders).toBe(base);
    readIn(scopeB, () => expect(count.value).toBe(1));
    readIn(scopeA, () => expect(count.value).toBe(0));
  });

  it("coalesces multiple synchronous writes in one dispatch into a single render with the latest value", async () => {
    const appScope = scope();
    const bump = event<void>();
    const count = store(0);
    reaction({
      on: bump,
      run() {
        count.value += 1;
        count.value += 1;
        count.value += 1;
      },
    });

    let renders = 0;
    function Counter() {
      renders += 1;
      return createElement("span", null, String(useUnit(count)));
    }

    renderWithScope(appScope, createElement(Counter));
    const base = renders;

    await act(async () => {
      await scoped(appScope, () => bump());
    });

    expect(screen.getByText("3")).toBeTruthy();
    expect(renders - base).toBe(1);
  });

  it("isolates reads and writes between sibling ScopeProviders", async () => {
    const scopeA = scope();
    const scopeB = scope();
    const bump = event<void>();
    const count = store(0);
    reaction({ on: bump, run: () => (count.value += 1) });

    let rendersB = 0;
    function Counter({ tid }: { tid: string }) {
      if (tid === "b") rendersB += 1;
      return createElement("span", { "data-testid": tid }, String(useUnit(count)));
    }

    render(
      createElement(
        "div",
        null,
        withScope(scopeA, createElement(Counter, { tid: "a" })),
        withScope(scopeB, createElement(Counter, { tid: "b" })),
      ),
    );

    expect(screen.getByTestId("a").textContent).toBe("0");
    expect(screen.getByTestId("b").textContent).toBe("0");
    const baseB = rendersB;

    await act(async () => {
      await scoped(scopeA, () => bump());
    });

    expect(screen.getByTestId("a").textContent).toBe("1");
    expect(screen.getByTestId("b").textContent).toBe("0");
    expect(rendersB).toBe(baseB);
  });

});
