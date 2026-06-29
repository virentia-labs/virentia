// @vitest-environment happy-dom

import { allSettled, event, reaction, scope, scoped, store } from "@virentia/core";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { act, createElement, StrictMode, type ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { component, createModelCache, ScopeProvider, useProvidedScope, useUnit } from "../lib";
import type { ModelContext } from "../lib";

afterEach(() => {
  cleanup();
});

describe("@virentia/react", () => {
  it("reads stores and calls events in the provided scope", async () => {
    const appScope = scope();
    const otherScope = scope();
    const incremented = event<number>();
    const count = store(0);

    reaction({
      on: incremented,
      run(amount) {
        count.value += amount;
      },
    });

    function Counter() {
      const value = useUnit(count);
      const increment = useUnit(incremented);

      return createElement("button", { onClick: () => increment(2) }, value);
    }

    renderWithScope(appScope, createElement(Counter));

    expect(button().textContent).toBe("0");

    await act(async () => {
      fireEvent.click(button());
    });

    expect(button().textContent).toBe("2");

    await act(async () => {
      await allSettled(incremented, { scope: otherScope, payload: 10 });
    });

    expect(button().textContent).toBe("2");
    scoped(otherScope, () => {
      expect(count.value).toBe(10);
    });
  });

  it("unwraps unit shapes with useUnit", async () => {
    const appScope = scope();
    const changed = event<string>();
    const name = store("Ada");
    const age = store(36);

    reaction({
      on: changed,
      run(value) {
        name.value = value;
      },
    });

    function Profile() {
      const [currentName, currentAge] = useUnit([name, age] as const);
      const units = useUnit({ changed, name });

      return createElement(
        "button",
        { onClick: () => units.changed("Grace") },
        `${currentName}:${units.name}:${currentAge}`,
      );
    }

    renderWithScope(appScope, createElement(Profile));

    expect(button().textContent).toBe("Ada:Ada:36");

    await act(async () => {
      fireEvent.click(button());
    });

    expect(button().textContent).toBe("Grace:Grace:36");
  });

  it("throws when a scope is not provided", () => {
    function Reader() {
      useProvidedScope();
      return null;
    }

    expect(() => render(createElement(Reader))).toThrow("[useProvidedScope] Scope is not provided");
  });

  it("creates component models, updates props, and emits lifecycle events", async () => {
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

  it("creates controlled component models outside React", async () => {
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
    const model = scoped(appScope, () => Counter.create({ step: 2 }));
    const view = render(createElement(Counter, { step: 2, model }));

    expect(lifecycle).toEqual(["mounted:1"]);

    await scoped(appScope, () => model.clicked());
    await waitFor(() => expect(button().textContent).toBe("2"));

    view.rerender(createElement(Counter, { step: 5, model }));

    await scoped(appScope, () => model.clicked());
    await waitFor(() => expect(button().textContent).toBe("7"));

    view.unmount();

    await scoped(appScope, () => model.clicked());

    scoped(appScope, () => {
      expect(model.count.value).toBe(12);
    });
    expect(lifecycle).toEqual(["mounted:1", "unmounted:0"]);

    model.dispose();
  });

  it("passes child component models through parent component models", async () => {
    const appScope = scope();

    function createCounterModel(context: ModelContext<{ step: number }>) {
      const clicked = event<void>();
      const count = store(0);

      reaction({
        on: clicked,
        run() {
          count.value += context.props.step;
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
    const Parent = component({
      model() {
        const counter = Counter.create({ step: 1 });

        return { counter };
      },
      view({ model }) {
        return createElement(Counter, { step: 2, model: model.counter });
      },
    });

    renderWithScope(appScope, createElement(Parent, {}));

    await act(async () => {
      fireEvent.click(button());
    });

    expect(button().textContent).toBe("2");
  });

  it("keeps cached models alive across unmounts until the cache deletes them", async () => {
    const appScope = scope();
    let created = 0;

    function createCachedModel() {
      created += 1;
      const clicked = event<void>();
      const count = store(0);

      reaction({
        on: clicked,
        run() {
          count.value += 1;
        },
      });

      return { clicked, count };
    }

    const cache = createModelCache<string, { id: string }, ReturnType<typeof createCachedModel>>();
    const CachedCounter = component({
      cache,
      key: (props: { id: string }) => props.id,
      model: createCachedModel,
      view({ model }) {
        return createElement("button", { onClick: () => model.clicked() }, model.count);
      },
    });

    const view = renderWithScope(appScope, createElement(CachedCounter, { id: "chat:1" }));

    await act(async () => {
      fireEvent.click(button());
    });

    expect(button().textContent).toBe("1");

    view.rerender(createElement(ScopeProvider, { scope: appScope }, null));

    expect(cache.has("chat:1", appScope)).toBe(true);

    view.rerender(
      createElement(
        ScopeProvider,
        { scope: appScope },
        createElement(CachedCounter, { id: "chat:1" }),
      ),
    );

    expect(button().textContent).toBe("1");
    expect(created).toBe(1);

    view.rerender(createElement(ScopeProvider, { scope: appScope }, null));
    cache.delete("chat:1", appScope);
    view.rerender(
      createElement(
        ScopeProvider,
        { scope: appScope },
        createElement(CachedCounter, { id: "chat:1" }),
      ),
    );

    expect(created).toBe(2);
    expect(button().textContent).toBe("0");
  });

  it("keeps factory model reactions alive across a StrictMode remount cycle", async () => {
    const appScope = scope();

    function createCounterModel(context: ModelContext<{ step: number }>) {
      const clicked = event<void>();
      const count = store(0);

      reaction({
        on: clicked,
        run() {
          count.value += context.props.step;
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

    // StrictMode runs mount -> unmount -> remount in dev with no render in
    // between. The deferred-dispose must skip disposing the reused instance.
    await act(async () => {
      render(
        createElement(
          StrictMode,
          null,
          createElement(ScopeProvider, { scope: appScope }, createElement(Counter, { step: 2 })),
        ),
      );
    });

    expect(button().textContent).toBe("0");

    // Without the fix the reaction is detached on the fake unmount, so the
    // click is a no-op and the text stays "0".
    await act(async () => {
      fireEvent.click(button());
    });

    expect(button().textContent).toBe("2");
  });
});

function renderWithScope(appScope: ReturnType<typeof scope>, element: ReactNode) {
  return render(createElement(ScopeProvider, { scope: appScope }, element));
}

function button() {
  return screen.getByRole("button");
}
