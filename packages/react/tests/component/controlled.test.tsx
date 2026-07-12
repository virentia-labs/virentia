// @vitest-environment happy-dom

import {
  event,
  reaction,
  scope,
  scoped,
  store,
  type EventCallable,
  type Store,
} from "@virentia/core";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { act, createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { component } from "../../lib";
import type { ComponentModel, ModelContext } from "../../lib";
import { readExposedModelInstance } from "../../lib/use-model";
import { isStoreUnit } from "../../lib/utils";
import { counterModelFactory } from "../support/counter-model";
import { resetAmbientScopeAfterEach } from "../support/ambient-scope-reset";
import { button, renderWithScope } from "../support/render-harness";

resetAmbientScopeAfterEach();

describe("component.create (controlled)", () => {
  it("throws when create() runs outside any active scope", () => {
    const C = component({ model: counterModelFactory(), view: () => null });
    expect(() => (C as any).create({ step: 1 })).toThrow(
      "[component.create] Parent component context is required",
    );
  });

  it("exposes dispose, Symbol.dispose, and raw units on the create() result", () => {
    const appScope = scope();
    const C = component({ model: counterModelFactory(), view: () => null });
    const m = scoped(appScope, () => (C as any).create({ step: 2 })) as ComponentModel<{
      count: Store<number>;
      clicked: EventCallable<void>;
    }>;

    expect(typeof (m as any).dispose).toBe("function");
    expect(typeof (m as any)[Symbol.dispose]).toBe("function");
    expect(isStoreUnit((m as any).count)).toBe(true); // raw store, not unwrapped
    const instance = readExposedModelInstance(m);
    expect(instance).not.toBeNull();
    expect(instance!.model).toBe(m);
    (m as any).dispose();
  });

  it("renders a controlled component with no ScopeProvider using the model's creation scope", async () => {
    const appScope = scope();
    const C = component({
      model: counterModelFactory(),
      view({ model }: any) {
        return createElement("button", { onClick: () => model.clicked() }, String(model.count));
      },
    });
    const m = scoped(appScope, () => (C as any).create({ step: 3 }));

    render(createElement(C, { step: 3, model: m } as any));
    expect(button().textContent).toBe("0");
    await act(async () => {
      await scoped(appScope, () => (m as any).clicked());
    });
    expect(button().textContent).toBe("3");
    (m as any).dispose();
  });

  it("throws when a controlled component receives a plain-object model prop", () => {
    const C = component({ model: counterModelFactory(), view: () => null });
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() =>
      render(createElement(C, { step: 1, model: { count: store(0) } } as any)),
    ).toThrow("[component] The model prop must be created with component.create().");
    consoleErr.mockRestore();
  });

  it("does not dispose a controlled instance on unmount", async () => {
    const appScope = scope();
    const C = component({
      model: counterModelFactory(),
      view({ model }: any) {
        return createElement("button", { onClick: () => model.clicked() }, String(model.count));
      },
    });
    const m = scoped(appScope, () => (C as any).create({ step: 2 }));
    const view = render(createElement(C, { step: 2, model: m } as any));

    await act(async () => {
      view.unmount();
    });
    await act(async () => {
      await Promise.resolve();
    });

    // Instance still alive: dispatch still mutates.
    await act(async () => {
      await scoped(appScope, () => (m as any).clicked());
    });
    scoped(appScope, () => expect((m as any).count.value).toBe(2));
    (m as any).dispose();
  });

  it("switches the rendered instance when the controlled model prop is swapped", async () => {
    const appScope = scope();
    const C = component({
      model: counterModelFactory(),
      view({ model }: any) {
        return createElement("button", { onClick: () => model.clicked() }, String(model.count));
      },
    });
    const a = scoped(appScope, () => (C as any).create({ step: 1 }));
    const b = scoped(appScope, () => (C as any).create({ step: 1 }));
    // pre-mutate A so the two instances are distinguishable
    await scoped(appScope, () => (a as any).clicked());
    await scoped(appScope, () => (a as any).clicked());

    const view = render(createElement(C, { step: 1, model: a } as any));
    expect(button().textContent).toBe("2");

    view.rerender(createElement(C, { step: 1, model: b } as any));
    expect(button().textContent).toBe("0");

    // A untouched and still alive.
    scoped(appScope, () => expect((a as any).count.value).toBe(2));
    (a as any).dispose();
    (b as any).dispose();
  });

  it("forwards a raw child ComponentModel from a parent as a controlled prop", async () => {
    const appScope = scope();
    const Child = component({
      model: counterModelFactory(),
      view({ model }: any) {
        return createElement("button", { onClick: () => model.clicked() }, String(model.count));
      },
    });
    let childModelInView: any = null;
    const Parent = component({
      model() {
        const child = (Child as any).create({ step: 2 });
        return { child };
      },
      view({ model }: any) {
        childModelInView = model.child;
        return createElement(Child, { step: 2, model: model.child });
      },
    });

    renderWithScope(appScope, createElement(Parent, {}));
    // The child is kept raw (still a ComponentModel with a raw store).
    expect(isStoreUnit(childModelInView.count)).toBe(true);
    expect(readExposedModelInstance(childModelInView)).not.toBeNull();

    await act(async () => {
      fireEvent.click(button());
    });
    expect(button().textContent).toBe("2");
  });

  // TODO(phase-2 dedup): overlaps "renders a controlled component with no ScopeProvider using the model's creation scope"
  it("creates a controlled component model outside React", async () => {
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

  // TODO(phase-2 dedup): overlaps "forwards a raw child ComponentModel from a parent as a controlled prop"
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
});
