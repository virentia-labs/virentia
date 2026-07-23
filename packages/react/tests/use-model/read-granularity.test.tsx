// @vitest-environment happy-dom

import { scope, scoped, store } from "@virentia/core";
import { screen } from "@testing-library/react";
import { act, createElement } from "react";
import { describe, expect, it } from "vitest";
import { useModel } from "../../lib";
import { resetAmbientScopeAfterEach } from "../support/ambient-scope-reset";
import { renderWithScope } from "../support/render-harness";

resetAmbientScopeAfterEach();

describe("useModel (read granularity)", () => {
  it("re-renders only for the fields the component actually reads", async () => {
    const appScope = scope();
    const a = store(0);
    const b = store(0);
    const model = { a, b };

    let renders = 0;
    function View() {
      renders += 1;
      const m = useModel(model);
      return createElement("span", null, String(m.a));
    }

    renderWithScope(appScope, createElement(View));
    const base = renders;
    expect(screen.getByText("0")).toBeTruthy();

    // `b` is never read in the view, so a write to it must not re-render.
    await act(async () => {
      scoped(appScope, () => {
        b.value += 1;
      });
    });
    expect(renders).toBe(base);
    expect(screen.getByText("0")).toBeTruthy();

    // `a` is read, so a write to it re-renders exactly once.
    await act(async () => {
      scoped(appScope, () => {
        a.value += 1;
      });
    });
    expect(renders).toBe(base + 1);
    expect(screen.getByText("1")).toBeTruthy();
  });

  it("does not re-render for a sub-model store the view never touches", async () => {
    const appScope = scope();
    const title = store("panel");
    const hidden = store(0);
    const model = { title, sub: { count: hidden } };

    let renders = 0;
    function View() {
      renders += 1;
      const m = useModel(model);
      return createElement("span", null, m.title);
    }

    renderWithScope(appScope, createElement(View));
    const base = renders;

    await act(async () => {
      scoped(appScope, () => {
        hidden.value += 1;
      });
    });
    expect(renders).toBe(base);
    expect(screen.getByText("panel")).toBeTruthy();
  });

  it("starts re-rendering for a field once the view begins reading it", async () => {
    const appScope = scope();
    const a = store("a0");
    const b = store("b0");
    const model = { a, b };

    let renders = 0;
    function View() {
      renders += 1;
      const m = useModel(model);
      // Reads `b` only after `a` reaches "a1" — the read set changes at runtime.
      return createElement("span", null, m.a === "a1" ? `${m.a}:${m.b}` : m.a);
    }

    renderWithScope(appScope, createElement(View));

    // Before `b` is read, a write to it is ignored.
    await act(async () => {
      scoped(appScope, () => {
        b.value = "b1";
      });
    });
    const beforeBRead = renders;

    // This write makes the view start reading `b`.
    await act(async () => {
      scoped(appScope, () => {
        a.value = "a1";
      });
    });
    expect(screen.getByText("a1:b1")).toBeTruthy();

    // Now `b` is read, so a further write to it re-renders.
    await act(async () => {
      scoped(appScope, () => {
        b.value = "b2";
      });
    });
    expect(renders).toBeGreaterThan(beforeBRead);
    expect(screen.getByText("a1:b2")).toBeTruthy();
  });
});
