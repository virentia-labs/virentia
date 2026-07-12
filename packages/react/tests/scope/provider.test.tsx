// @vitest-environment happy-dom

import { scope, scoped, store } from "@virentia/core";
import { render, screen } from "@testing-library/react";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { useProvidedScope, useUnit } from "../../lib";
import { useOptionalProvidedScope } from "../../lib/scope";
import type { Scope } from "@virentia/core";
import { resetAmbientScopeAfterEach } from "../support/ambient-scope-reset";
import { withScope } from "../support/render-harness";

resetAmbientScopeAfterEach();

describe("ScopeProvider", () => {
  it("overrides the outer provider within a nested ScopeProvider subtree", () => {
    const scopeA = scope();
    const scopeB = scope();
    const s = store(0);
    scoped(scopeA, () => (s.value = 10));
    scoped(scopeB, () => (s.value = 20));

    function Reader() {
      return createElement("span", null, String(useUnit(s)));
    }

    render(
      withScope(scopeA, withScope(scopeB, createElement(Reader))),
    );
    expect(screen.getByText("20")).toBeTruthy();
  });

  it("returns null from useOptionalProvidedScope when no provider is present", () => {
    let captured: Scope | null | undefined;
    function Reader() {
      captured = useOptionalProvidedScope();
      return null;
    }
    render(createElement(Reader));
    expect(captured).toBeNull();
  });

  // TODO(phase-2 dedup): overlaps "throws when an uncontrolled component renders without a ScopeProvider"
  it("throws from useProvidedScope when no scope is provided", () => {
    function Reader() {
      useProvidedScope();
      return null;
    }

    expect(() => render(createElement(Reader))).toThrow("[useProvidedScope] Scope is not provided");
  });
});
