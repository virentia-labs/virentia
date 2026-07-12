// @vitest-environment happy-dom

import { event, reaction, scope, store } from "@virentia/core";
import { fireEvent } from "@testing-library/react";
import { act, createElement } from "react";
import { describe, expect, it } from "vitest";
import { useModel } from "../../lib";
import { isStoreUnit } from "../../lib/utils";
import { resetAmbientScopeAfterEach } from "../support/ambient-scope-reset";
import { button, renderWithScope } from "../support/render-harness";

resetAmbientScopeAfterEach();

describe("useModel (raw model)", () => {
  it("unwraps unit fields to values with bound callbacks and creates no instance", async () => {
    const appScope = scope();
    const inc = event<void>();
    const count = store(0);
    reaction({ on: inc, run: () => (count.value += 1) });
    const model = { count, inc };

    function View() {
      const view = useModel(model);
      return createElement("button", { onClick: () => view.inc() }, String(view.count));
    }

    renderWithScope(appScope, createElement(View));
    expect(button().textContent).toBe("0");
    await act(async () => {
      fireEvent.click(button());
    });
    expect(button().textContent).toBe("1");
  });

  it("unwraps an enumerable symbol-keyed unit field", () => {
    const appScope = scope();
    const sym = Symbol("s");
    const model = { [sym]: store(7) };

    let captured: Record<PropertyKey, unknown> | null = null;
    function View() {
      captured = useModel(model) as Record<PropertyKey, unknown>;
      return null;
    }
    renderWithScope(appScope, createElement(View));
    expect(captured![sym]).toBe(7);
  });

  it("keeps plain methods, class instances, and array-of-store fields raw", () => {
    const appScope = scope();
    const greet = () => "hi";
    const when = new Date(0);
    class Tag {
      n = store(1);
    }
    const tag = new Tag();
    const items = [store(1), store(2)];
    const model = { greet, when, tag, items, count: store(3) };

    let view: any = null;
    function View() {
      view = useModel(model);
      return null;
    }
    renderWithScope(appScope, createElement(View));

    expect(view.greet).toBe(greet);
    expect(view.greet()).toBe("hi");
    expect(view.when).toBe(when);
    expect(view.tag).toBe(tag);
    expect(isStoreUnit(view.tag.n)).toBe(true); // not unwrapped
    expect(Array.isArray(view.items)).toBe(true);
    expect(isStoreUnit(view.items[0])).toBe(true); // array elements not unwrapped
    expect(view.count).toBe(3); // top-level store IS unwrapped
  });
});
