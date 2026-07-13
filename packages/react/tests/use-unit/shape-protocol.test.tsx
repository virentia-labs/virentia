// @vitest-environment happy-dom

import { event, reaction, scope, store } from "@virentia/core";
import { fireEvent, render } from "@testing-library/react";
import { act, createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { SHAPE, useModel, useUnit } from "../../lib";
import { resetAmbientScopeAfterEach } from "../support/ambient-scope-reset";
import { button, ErrorBoundary, renderWithScope, withScope } from "../support/render-harness";

resetAmbientScopeAfterEach();

describe("useUnit (@@shape protocol)", () => {
  it("binds an opaque value through its @@shape object declaration", async () => {
    const appScope = scope();
    const changed = event<string>();
    const name = store("Ada");
    reaction({ on: changed, run: (value) => (name.value = value) });

    // A class instance is opaque to useUnit's key iteration; @@shape names the
    // bindable units directly, no function needed.
    class Model {
      readonly name = name;
      readonly changed = changed;
      readonly [SHAPE] = { name: this.name, changed: this.changed };
      greet() {
        return "hi";
      }
    }

    let captured!: { name: string; changed: (v: string) => Promise<void> };
    function View() {
      captured = useUnit(new Model());
      return createElement("button", { onClick: () => captured.changed("Grace") }, captured.name);
    }

    renderWithScope(appScope, createElement(View));
    expect(button().textContent).toBe("Ada");

    await act(async () => {
      fireEvent.click(button());
    });

    expect(button().textContent).toBe("Grace");
  });

  it("accepts the effector-style @@shape method form", () => {
    const appScope = scope();
    const count = store(7);
    const source = {
      count,
      [SHAPE]() {
        return { count: this.count };
      },
    };

    let captured!: { count: number };
    function View() {
      captured = useUnit(source);
      return null;
    }

    renderWithScope(appScope, createElement(View));
    expect(captured.count).toBe(42 - 35);
  });

  it("resolves nested @@shape declarations to any depth", async () => {
    const appScope = scope();
    const tick = event<void>();
    const count = store(0);
    reaction({ on: tick, run: () => (count.value += 1) });

    const inner = { count, [SHAPE]: { count } };
    const outer = {
      [SHAPE]: {
        header: { title: store("panel") }, // bare nested record (no @@shape)
        counter: inner, // nested @@shape source
        tick,
      },
    };

    let captured!: {
      header: { title: string };
      counter: { count: number };
      tick: () => Promise<void>;
    };
    function View() {
      captured = useUnit(outer);
      return createElement(
        "button",
        { onClick: () => captured.tick() },
        `${captured.header.title}:${captured.counter.count}`,
      );
    }

    renderWithScope(appScope, createElement(View));
    expect(button().textContent).toBe("panel:0");

    await act(async () => {
      fireEvent.click(button());
    });

    expect(button().textContent).toBe("panel:1");
  });

  it("binds a model field that declares @@shape and hides the marker key", () => {
    const appScope = scope();
    const value = store("v");

    class SubModel {
      readonly value = value;
      readonly [SHAPE] = { value: this.value };
    }

    const model = { sub: new SubModel(), plain: store(1) };

    let captured!: { sub: { value: string }; plain: number };
    function View() {
      captured = useModel(model);
      return null;
    }

    renderWithScope(appScope, createElement(View));
    expect(captured.sub).toEqual({ value: "v" });
    expect(captured.plain).toBe(1);
    expect(SHAPE in (captured.sub as object)).toBe(false);
  });

  it("throws on a cyclic @@shape instead of recursing forever", () => {
    const appScope = scope();
    const cyclic: Record<PropertyKey, unknown> = { count: store(0) };
    cyclic[SHAPE] = { self: cyclic }; // the shape resolves back to its own source

    const errors: Error[] = [];
    function View() {
      useUnit(cyclic);
      return null;
    }

    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      withScope(
        appScope,
        createElement(ErrorBoundary, { onError: (e) => errors.push(e) }, createElement(View)),
      ),
    );
    spy.mockRestore();

    expect(errors.some((e) => /cyclic/i.test(e.message))).toBe(true);
  });

  it("allows a shape reused in sibling positions (diamond, not cycle)", () => {
    const appScope = scope();
    const value = store(1);
    const sub = { value, [SHAPE]: { value } };
    const root = { [SHAPE]: { a: sub, b: sub } }; // same source object in two slots

    let captured!: { a: { value: number }; b: { value: number } };
    function View() {
      captured = useUnit(root);
      return null;
    }

    renderWithScope(appScope, createElement(View));
    expect(captured.a.value).toBe(1);
    expect(captured.b.value).toBe(1);
  });
});
