// @vitest-environment happy-dom

import { effect, event, reaction, scope, scoped, setErrorReporter, store } from "@virentia/core";
import type { VirentiaFailureReport } from "@virentia/core";
import { act, createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { useUnit } from "../../lib";
import { resetAmbientScopeAfterEach } from "../support/ambient-scope-reset";
import { renderWithScope } from "../support/render-harness";

resetAmbientScopeAfterEach();

// Production concerns for the React binding: a failing rule must not corrupt the
// rendered tree, an unmounted component must go quiet, and failures must stay
// reportable from inside a React update.
describe("React under failing rules and lifecycle churn", () => {
  afterEach(() => {
    setErrorReporter(null);
  });

  it("keeps rendering the correct value when an unrelated reaction throws", async () => {
    const reports: VirentiaFailureReport[] = [];
    setErrorReporter((failure) => reports.push(failure));

    const appScope = scope();
    const $n = store(0, undefined, { name: "$n" });

    reaction({
      name: "brokenRule",
      on: $n,
      run: () => {
        throw new Error("rule is broken");
      },
    });

    const View = () => createElement("div", null, String(useUnit($n)));
    const rendered = renderWithScope(appScope, createElement(View));

    await act(async () => {
      scoped(appScope, () => {
        $n.value = 5;
      });
    });

    // The tree still shows the committed value...
    expect(rendered.container.textContent).toBe("5");
    // ...and the failure was reported with the rule's name, not swallowed.
    expect(reports.map((r) => r.unit)).toContain('reaction "brokenRule"');
  });

  it("does not update after unmount", async () => {
    const appScope = scope();
    const $n = store(0);
    const renders: number[] = [];

    const View = () => {
      const n = useUnit($n);

      renders.push(n);

      return createElement("div", null, String(n));
    };

    const rendered = renderWithScope(appScope, createElement(View));

    await act(async () => {
      scoped(appScope, () => {
        $n.value = 1;
      });
    });

    const before = renders.length;

    rendered.unmount();

    await act(async () => {
      scoped(appScope, () => {
        $n.value = 2;
      });
    });

    expect(renders.length).toBe(before);
  });

  it("survives rapid successive updates without losing the last value", async () => {
    const appScope = scope();
    const $n = store(0);

    const View = () => createElement("div", null, String(useUnit($n)));
    const rendered = renderWithScope(appScope, createElement(View));

    await act(async () => {
      scoped(appScope, () => {
        for (let i = 1; i <= 50; i += 1) $n.value = i;
      });
    });

    expect(rendered.container.textContent).toBe("50");
  });

  it("reflects effect pending through a render", async () => {
    const appScope = scope();
    let release: ((value: string) => void) | undefined;
    const fx = effect(() => new Promise<string>((resolve) => (release = resolve)));

    const View = () => createElement("div", null, useUnit(fx.pending) ? "loading" : "idle");
    const rendered = renderWithScope(appScope, createElement(View));

    expect(rendered.container.textContent).toBe("idle");

    let call!: Promise<string>;
    await act(async () => {
      call = scoped(appScope, () => fx(undefined as never));
    });

    expect(rendered.container.textContent).toBe("loading");

    await act(async () => {
      release?.("done");
      await call;
    });

    expect(rendered.container.textContent).toBe("idle");
  });

  it("leaves pending consistent when the effect rejects", async () => {
    const appScope = scope();
    const fx = effect(async () => {
      throw new Error("request failed");
    });
    const failures: unknown[] = [];

    reaction({ on: fx.failData, run: (error) => failures.push(error) });

    const View = () => createElement("div", null, useUnit(fx.pending) ? "loading" : "idle");
    const rendered = renderWithScope(appScope, createElement(View));

    await act(async () => {
      await scoped(appScope, () => fx(undefined as never)).catch(() => undefined);
    });

    expect(rendered.container.textContent).toBe("idle");
    expect(failures).toHaveLength(1);
  });

  it("keeps an event-driven update flowing into the tree", async () => {
    const appScope = scope();
    const submit = event<string>();
    const $query = store("");

    reaction({ on: submit, run: (value: string) => void ($query.value = value) });

    const View = () => createElement("div", null, useUnit($query));
    const rendered = renderWithScope(appScope, createElement(View));

    await act(async () => {
      scoped(appScope, () => submit("hello"));
    });

    expect(rendered.container.textContent).toBe("hello");
  });
});
