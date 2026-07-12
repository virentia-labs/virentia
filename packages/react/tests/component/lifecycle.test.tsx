// @vitest-environment happy-dom

import { event, reaction, scope, store } from "@virentia/core";
import { fireEvent, render } from "@testing-library/react";
import { act, createElement, StrictMode } from "react";
import { describe, expect, it, vi } from "vitest";
import { component, ScopeProvider } from "../../lib";
import type { ModelContext } from "../../lib";
import { counterModelFactory } from "../support/counter-model";
import { resetAmbientScopeAfterEach } from "../support/ambient-scope-reset";
import { button, renderWithScope, withScope } from "../support/render-harness";

resetAmbientScopeAfterEach();

describe("component (lifecycle)", () => {
  it("throws when an uncontrolled component renders without a ScopeProvider", () => {
    const C = component({
      model: counterModelFactory(),
      view: () => null,
    });
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(createElement(C, { step: 1 }))).toThrow(
      "[useProvidedScope] Scope is not provided",
    );
    consoleErr.mockRestore();
  });

  it("disposes an uncontrolled instance on real unmount", async () => {
    const appScope = scope();
    const lifecycle: string[] = [];
    const C = component({
      model: counterModelFactory(lifecycle),
      view({ model }: any) {
        return createElement("button", { onClick: () => model.clicked() }, String(model.count));
      },
    });

    const view = renderWithScope(appScope, createElement(C, { step: 2 }));
    expect(lifecycle).toEqual(["mounted"]);

    await act(async () => {
      view.unmount();
    });
    // flush the deferred-dispose microtask
    await act(async () => {
      await Promise.resolve();
    });
    expect(lifecycle).toEqual(["mounted", "unmounted"]);
  });

  it("reuses the instance and keeps reactions alive across a StrictMode remount", async () => {
    const appScope = scope();
    const lifecycle: string[] = [];
    const C = component({
      model: counterModelFactory(lifecycle),
      view({ model }: any) {
        return createElement("button", { onClick: () => model.clicked() }, String(model.count));
      },
    });

    await act(async () => {
      render(
        createElement(
          StrictMode,
          null,
          withScope(appScope, createElement(C, { step: 2 })),
        ),
      );
    });

    expect(lifecycle).toEqual(["mounted", "unmounted", "mounted"]);

    await act(async () => {
      fireEvent.click(button());
    });
    // Reaction still attached: click worked.
    expect(button().textContent).toBe("2");
  });

  it("rewrites a props change into the props store so reactions observe it", async () => {
    const appScope = scope();
    const observed: number[] = [];
    function createModel(context: ModelContext<{ step: number }>) {
      const clicked = event<void>();
      const count = store(0);
      reaction({ on: clicked, run: () => (count.value += context.props.step) });
      return { clicked, count };
    }
    const C = component({
      model: createModel,
      view({ model }: any) {
        return createElement("button", { onClick: () => model.clicked() }, String(model.count));
      },
    });

    const view = renderWithScope(appScope, createElement(C, { step: 2 }));
    await act(async () => {
      fireEvent.click(button());
    });
    expect(button().textContent).toBe("2");

    view.rerender(withScope(appScope, createElement(C, { step: 5 })));
    await act(async () => {
      fireEvent.click(button());
    });
    // New prop observed by the reaction: 2 + 5 = 7.
    expect(button().textContent).toBe("7");
    void observed;
  });

  it("does not recreate the instance on a props-only change", async () => {
    const appScope = scope();
    let created = 0;
    function createModel(context: ModelContext<{ step: number }>) {
      created += 1;
      const clicked = event<void>();
      const count = store(0);
      reaction({ on: clicked, run: () => (count.value += context.props.step) });
      return { clicked, count };
    }
    const C = component({
      model: createModel,
      view({ model }: any) {
        return createElement("button", { onClick: () => model.clicked() }, String(model.count));
      },
    });

    const view = renderWithScope(appScope, createElement(C, { step: 1 }));
    expect(created).toBe(1);
    await act(async () => {
      fireEvent.click(button());
    });
    expect(button().textContent).toBe("1");

    view.rerender(withScope(appScope, createElement(C, { step: 9 })));
    // Same instance: count preserved, not reset.
    expect(created).toBe(1);
    await act(async () => {
      fireEvent.click(button());
    });
    expect(button().textContent).toBe("10");
  });

  it("recreates the model instance when the provided scope changes", async () => {
    const scopeA = scope();
    const scopeB = scope();
    let created = 0;
    function createModel(context: ModelContext<{ step: number }>) {
      created += 1;
      const clicked = event<void>();
      const count = store(0);
      reaction({ on: clicked, run: () => (count.value += context.props.step) });
      return { clicked, count };
    }
    const C = component({
      model: createModel,
      view({ model }: any) {
        return createElement("button", { onClick: () => model.clicked() }, String(model.count));
      },
    });

    const view = renderWithScope(scopeA, createElement(C, { step: 1 }));
    await act(async () => {
      fireEvent.click(button());
    });
    expect(button().textContent).toBe("1");
    expect(created).toBe(1);

    view.rerender(withScope(scopeB, createElement(C, { step: 1 })));
    expect(created).toBe(2);
    // Fresh instance in scopeB starts at 0.
    expect(button().textContent).toBe("0");
  });

  // kept: uniquely asserts context.mounted/unmounted reactions and mounts.value (mounted:1, unmounted:0); partner only covers the props-change path
  it("drives a component model through prop updates and lifecycle events", async () => {
    const appScope = scope();
    const lifecycle: string[] = [];

    function createCounterModel(context: ModelContext<{ step: number }>) {
      const clicked = event<void>();
      const count = store(0);

      reaction({
        on: clicked,
        run() {
          count.value += context.props.step;
        },
      });

      reaction({
        on: context.mounted,
        run() {
          lifecycle.push(`mounted:${context.mounts.value}`);
        },
      });

      reaction({
        on: context.unmounted,
        run() {
          lifecycle.push(`unmounted:${context.mounts.value}`);
        },
      });

      return { clicked, count };
    }

    const Counter = component({
      model: createCounterModel,
      view({ model }) {
        return createElement("button", { onClick: () => model.clicked() }, model.count);
      },
    });

    const view = renderWithScope(appScope, createElement(Counter, { step: 2 }));

    expect(lifecycle).toEqual(["mounted:1"]);

    await act(async () => {
      fireEvent.click(button());
    });

    expect(button().textContent).toBe("2");

    view.rerender(
      createElement(ScopeProvider, { scope: appScope }, createElement(Counter, { step: 3 })),
    );

    await act(async () => {
      fireEvent.click(button());
    });

    expect(button().textContent).toBe("5");

    view.unmount();

    expect(lifecycle).toEqual(["mounted:1", "unmounted:0"]);
  });

  it("unwraps nested units at depth in the view while staying reactive", async () => {
    const appScope = scope();

    function createNestedModel() {
      const bump = event<void>();
      const count = store(0);
      const group = { total: store(0), sub: { n: store(0) } };
      reaction({
        on: bump,
        run() {
          count.value += 1;
          group.total.value += 10;
          group.sub.n.value += 100;
        },
      });
      return { count, bump, group };
    }

    const Nested = component({
      model: createNestedModel,
      view({ model }) {
        // `model.count`, `model.group.total`, `model.group.sub.n` are unwrapped
        // numbers (nested at depth 1 and 2), not stores.
        return createElement(
          "button",
          { onClick: () => model.bump() },
          `${model.count}/${model.group.total}/${model.group.sub.n}`,
        );
      },
    });

    renderWithScope(appScope, createElement(Nested, {}));
    expect(button().textContent).toBe("0/0/0");

    await act(async () => {
      fireEvent.click(button());
    });
    expect(button().textContent).toBe("1/10/100");
  });
});
