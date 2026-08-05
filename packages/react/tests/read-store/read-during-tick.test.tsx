// @vitest-environment happy-dom

import { computed, event, reaction, scope, scoped, store } from "@virentia/core";
import { act, createElement } from "react";
import { describe, expect, it } from "vitest";
import { useUnit } from "../../lib";
import { resetAmbientScopeAfterEach } from "../support/ambient-scope-reset";
import { renderWithScope } from "../support/render-harness";

resetAmbientScopeAfterEach();

// A rendering component is a reader of derived stores, and it reads them while
// updates are in flight. That is exactly the shape that used to swallow a
// derived store's own notification, so it needs covering from the React side.
describe("React components reading derived stores mid-update", () => {
  it("re-renders and still fires a reaction on the same derived store", async () => {
    const appScope = scope();
    const $token = store("", undefined, { name: "$token" });
    const $authorized = $token.map(Boolean);
    const reactionHits: boolean[] = [];

    reaction({ on: $authorized, run: (v: boolean) => reactionHits.push(v) });

    const rendered: boolean[] = [];
    const View = () => {
      const authorized = useUnit($authorized);

      rendered.push(authorized);

      return createElement("div", null, String(authorized));
    };

    renderWithScope(appScope, createElement(View));

    await act(async () => {
      scoped(appScope, () => {
        $token.value = "abc";
      });
    });

    expect(rendered.at(-1)).toBe(true);
    expect(reactionHits).toEqual([true]);
  });

  it("a component reading the derived does not starve a sibling reaction", async () => {
    const appScope = scope();
    const $n = store(0);
    const $doubled = $n.map((v) => v * 2);
    const seen: number[] = [];

    // The component materializes the derived first; the reaction must still fire.
    const View = () => {
      const doubled = useUnit($doubled);

      return createElement("div", null, String(doubled));
    };

    renderWithScope(appScope, createElement(View));

    reaction({ on: $doubled, run: (v: number) => seen.push(v) });

    await act(async () => {
      scoped(appScope, () => {
        $n.value = 3;
      });
    });

    expect(seen).toEqual([6]);
  });

  it("keeps two components on different scopes independent", async () => {
    const a = scope();
    const b = scope();
    const $n = store(1);
    const $label = $n.map((v) => `v${v}`);

    const View = () => createElement("div", null, useUnit($label));

    const first = renderWithScope(a, createElement(View));
    const second = renderWithScope(b, createElement(View));

    await act(async () => {
      scoped(a, () => {
        $n.value = 7;
      });
    });

    expect(first.container.textContent).toBe("v7");
    expect(second.container.textContent).toBe("v1");
  });

  it("renders the value written from inside a reaction body", async () => {
    const appScope = scope();
    const go = event<number>();
    const $n = store(0);
    const $doubled = $n.map((v) => v * 2);

    reaction({
      on: go,
      run: (v: number) => {
        $n.value = v;
        // A read in the same tick used to poison the notification.
        void $doubled.value;
      },
    });

    const View = () => createElement("div", null, String(useUnit($doubled)));

    const rendered = renderWithScope(appScope, createElement(View));

    await act(async () => {
      scoped(appScope, () => go(4));
    });

    expect(rendered.container.textContent).toBe("8");
  });

  it("follows a chained derived through a render", async () => {
    const appScope = scope();
    const $raw = store(1);
    const $step1 = $raw.map((v) => v + 1);
    const $step2 = computed(() => $step1.value * 10);

    const View = () => createElement("div", null, String(useUnit($step2)));

    const rendered = renderWithScope(appScope, createElement(View));

    expect(rendered.container.textContent).toBe("20");

    await act(async () => {
      scoped(appScope, () => {
        $raw.value = 4;
      });
    });

    expect(rendered.container.textContent).toBe("50");
  });
});
