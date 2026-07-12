// @vitest-environment happy-dom

import { event, scope, store } from "@virentia/core";
import { fireEvent, render } from "@testing-library/react";
import { createElement, useState } from "react";
import { describe, expect, it } from "vitest";
import { useModel } from "../../lib";
import type { ModelContext } from "../../lib";
import { resetAmbientScopeAfterEach } from "../support/ambient-scope-reset";
import { button, captureHookError, ErrorBoundary, withScope } from "../support/render-harness";

resetAmbientScopeAfterEach();

describe("useModel (Rules of Hooks)", () => {
  it("throws a hooks error when a field's unit-kind flips at the same call site", async () => {
    const appScope = scope();
    const asStore = { field: store(0) };
    const asEvent = { field: event<void>() };
    const errors: Error[] = [];

    function Flipper() {
      const [flip, setFlip] = useState(false);
      useModel(flip ? asEvent : asStore);
      return createElement("button", { onClick: () => setFlip(true) }, "go");
    }

    render(
      withScope(
        appScope,
        createElement(ErrorBoundary, { onError: (e) => errors.push(e) }, createElement(Flipper)),
      ),
    );

    const all = await captureHookError(() => fireEvent.click(button()), errors);
    // Flipping a field's unit-kind (store => 4 hooks via useStoreUnit, event => 1
    // hook) at the same call site violates the Rules of Hooks. React surfaces
    // this as a render crash to the error boundary (the exact message is
    // version-specific), so we assert an error was raised, not its wording.
    expect(all.length).toBeGreaterThan(0);
  });

  it("throws a hooks error when swapping factory and raw-model branches at one call site", async () => {
    const appScope = scope();
    const rawModel = { count: store(0) };
    const factory = (_ctx: ModelContext<Record<string, never>>) => ({ count: store(0) });
    const errors: Error[] = [];

    // Start on the factory path (more hooks), flip to the raw path (fewer hooks)
    // to guarantee a "rendered fewer hooks" hard error.
    function Flipper() {
      const [asRaw, setAsRaw] = useState(false);
      if (asRaw) {
        useModel(rawModel);
      } else {
        useModel(factory, {});
      }
      return createElement("button", { onClick: () => setAsRaw(true) }, "go");
    }

    render(
      withScope(
        appScope,
        createElement(ErrorBoundary, { onError: (e) => errors.push(e) }, createElement(Flipper)),
      ),
    );

    const all = await captureHookError(() => fireEvent.click(button()), errors);
    // Factory path runs extra hooks (useModelInstance) vs the raw-model path;
    // swapping branch at one call site is a Rules-of-Hooks violation that React
    // surfaces as a render crash to the error boundary.
    expect(all.length).toBeGreaterThan(0);
  });
});
