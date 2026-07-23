// @vitest-environment happy-dom

import { event, scope, store } from "@virentia/core";
import { fireEvent, render } from "@testing-library/react";
import { act, createElement, useState } from "react";
import { describe, expect, it } from "vitest";
import { useModel } from "../../lib";
import type { ModelContext } from "../../lib";
import { resetAmbientScopeAfterEach } from "../support/ambient-scope-reset";
import { button, captureHookError, ErrorBoundary, withScope } from "../support/render-harness";

resetAmbientScopeAfterEach();

describe("useModel (Rules of Hooks)", () => {
  it("handles a field's unit-kind flipping at the same call site without a hooks error", async () => {
    const appScope = scope();
    const asStore = { field: store(0) };
    const asEvent = { field: event<void>() };
    const errors: Error[] = [];

    let captured: { field: unknown } | null = null;
    function Flipper() {
      const [flip, setFlip] = useState(false);
      captured = useModel(flip ? asEvent : asStore) as { field: unknown };
      return createElement("button", { onClick: () => setFlip(true) }, "go");
    }

    render(
      withScope(
        appScope,
        createElement(ErrorBoundary, { onError: (e) => errors.push(e) }, createElement(Flipper)),
      ),
    );

    // The whole model binds through one useSyncExternalStore, so its hook count
    // is independent of a field's unit-kind. Flipping store => event at the same
    // call site is no longer a Rules-of-Hooks violation: the store field reads as
    // a value, and after the flip the event field reads as a bound callable.
    expect(captured!.field).toBe(0);
    await act(async () => {
      fireEvent.click(button());
    });
    expect(errors).toEqual([]);
    expect(typeof captured!.field).toBe("function");
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
