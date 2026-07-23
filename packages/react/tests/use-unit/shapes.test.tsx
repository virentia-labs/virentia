// @vitest-environment happy-dom

import { effect, event, reaction, scope, store } from "@virentia/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { act, createElement, useState } from "react";
import { describe, expect, it } from "vitest";
import { useUnit } from "../../lib";
import { resetAmbientScopeAfterEach } from "../support/ambient-scope-reset";
import { button, ErrorBoundary, renderWithScope, withScope } from "../support/render-harness";

resetAmbientScopeAfterEach();

describe("useUnit (shapes)", () => {
  it("resolves a mixed array of store, event, and effect positionally", async () => {
    const appScope = scope();
    const bump = event<number>();
    const count = store(0);
    const doubleFx = effect(async (n: number) => n * 2);
    reaction({ on: bump, run: (n) => (count.value += n) });

    let lastResult = 0;
    function Widget() {
      const [value, inc, dbl] = useUnit([count, bump, doubleFx] as const);
      return createElement(
        "button",
        {
          onClick: async () => {
            // Await sequentially: overlapping unawaited async `scoped(...)` calls
            // interleave their restore-on-settle and corrupt core's ambient
            // scope global (see suspected core bug), which would leak into later
            // tests.
            await inc(2);
            lastResult = await dbl(10);
          },
        },
        String(value),
      );
    }

    renderWithScope(appScope, createElement(Widget));
    expect(button().textContent).toBe("0");

    await act(async () => {
      fireEvent.click(button());
    });

    expect(button().textContent).toBe("2");
    expect(lastResult).toBe(20);
  });

  it("unwraps each key of an object shape identically", () => {
    const appScope = scope();
    const changed = event<string>();
    const name = store("Ada");

    let captured: { changed: unknown; name: unknown } | null = null;
    function Profile() {
      captured = useUnit({ changed, name });
      return null;
    }

    renderWithScope(appScope, createElement(Profile));
    expect(captured!.name).toBe("Ada");
    expect(typeof captured!.changed).toBe("function");
  });

  it("keeps a callback identity stable until the provided scope changes", async () => {
    const scopeA = scope();
    const scopeB = scope();
    const evt = event<void>();

    const seen: unknown[] = [];
    let force!: (n: number) => void;
    function Reader() {
      const [n, setN] = useState(0);
      force = setN;
      const cb = useUnit(evt);
      seen.push(cb);
      return createElement("span", null, String(n));
    }

    const view = renderWithScope(scopeA, createElement(Reader));
    await act(async () => {
      force(1);
    });
    // Identity stable while scope+unit unchanged.
    expect(seen[0]).toBe(seen[1]);

    // Changing the provided scope produces a new callback identity.
    view.rerender(withScope(scopeB, createElement(Reader)));
    expect(seen[seen.length - 1]).not.toBe(seen[0]);
  });

  it("grows the useUnit array between renders without a hooks-count error", async () => {
    const appScope = scope();
    const a = store(1);
    const b = store(2);
    const errors: Error[] = [];

    function Flipper() {
      const [big, setBig] = useState(false);
      const units = useUnit(big ? [a, b] : [a]);
      return createElement("button", { onClick: () => setBig(true) }, units.join(","));
    }

    render(
      withScope(
        appScope,
        createElement(ErrorBoundary, { onError: (e) => errors.push(e) }, createElement(Flipper)),
      ),
    );
    expect(button().textContent).toBe("1");

    // One useSyncExternalStore backs the whole shape, so the array changing size
    // is no longer a hooks-count violation — the new element simply appears.
    await act(async () => {
      fireEvent.click(button());
    });
    expect(errors).toEqual([]);
    expect(button().textContent).toBe("1,2");
  });

  // kept: partner only does a static record read; this uniquely asserts record-shape reactivity (units.name updates "Ada"->"Grace" on dispatch) plus combined tuple+record use
  it("unwraps a tuple shape and a record shape in the same component", async () => {
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
});
