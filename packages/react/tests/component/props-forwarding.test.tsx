// @vitest-environment happy-dom

import { scope } from "@virentia/core";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { component } from "../../lib";
import { counterModelFactory } from "../support/counter-model";
import { resetAmbientScopeAfterEach } from "../support/ambient-scope-reset";
import { renderWithScope } from "../support/render-harness";

resetAmbientScopeAfterEach();

describe("component (props forwarding)", () => {
  it("strips the incoming model prop and passes the reactive view as model", () => {
    const appScope = scope();
    let seenProps: Record<string, unknown> | null = null;
    const C = component({
      model: counterModelFactory(),
      view(props: any) {
        seenProps = props;
        return null;
      },
    });
    renderWithScope(appScope, createElement(C, { step: 2 }));
    expect(seenProps).not.toBeNull();
    expect("model" in seenProps!).toBe(true); // the reactive view is passed as `model`
    expect((seenProps as any).step).toBe(2);
  });
});
