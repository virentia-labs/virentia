// @vitest-environment happy-dom

import { event, reaction, scope, store } from "@virentia/core";
import { act, createContext, createElement, useContext } from "react";
import { describe, expect, it } from "vitest";
import { component, type ModelContext } from "../../lib";
import { resetAmbientScopeAfterEach } from "../support/ambient-scope-reset";
import { button, renderWithScope, withScope } from "../support/render-harness";

resetAmbientScopeAfterEach();

// A model whose props differ from the component's external props: the component
// takes `{ label }`, the model needs `{ label; uuid }`.
function createPageModel({ props }: ModelContext<{ label: string; uuid: string }>) {
  const opened = event<void>();
  const openedWith = store("");
  reaction({ on: opened, run: () => (openedWith.value = `${props.label}:${props.uuid}`) });
  return { opened, openedWith };
}

describe("component (mapProps)", () => {
  it("maps external props to model props, and the view keeps external props", () => {
    const appScope = scope();
    let seenView: Record<string, unknown> | null = null;

    const Page = component({
      mapProps: (props: { label: string }) => ({ ...props, uuid: "u-1" }),
      model: createPageModel,
      view(props: { label: string; model: { opened: () => void; openedWith: string } }) {
        seenView = props;
        return createElement(
          "button",
          { onClick: () => props.model.opened() },
          props.model.openedWith,
        );
      },
    });

    renderWithScope(appScope, createElement(Page, { label: "home" }));

    // The view receives the EXTERNAL props (no uuid), plus the model.
    expect(seenView!.label).toBe("home");
    expect("uuid" in seenView!).toBe(false);
    expect("model" in seenView!).toBe(true);
  });

  it("feeds the mapped uuid into the model", async () => {
    const appScope = scope();

    const Page = component({
      mapProps: (props: { label: string }) => ({ ...props, uuid: "u-42" }),
      model: createPageModel,
      view(props: { model: { opened: () => void; openedWith: string } }) {
        return createElement(
          "button",
          { onClick: () => props.model.opened() },
          props.model.openedWith || "idle",
        );
      },
    });

    renderWithScope(appScope, createElement(Page, { label: "home" }));
    expect(button().textContent).toBe("idle");

    await act(async () => {
      button().click();
    });

    expect(button().textContent).toBe("home:u-42");
  });

  it("runs mapProps during render, so it may read React context/hooks", async () => {
    const appScope = scope();
    const UuidContext = createContext("ctx-default");

    // mapProps calls a hook (useContext) — allowed because it runs in render.
    const Page = component({
      mapProps: (props: { label: string }) => {
        const uuid = useContext(UuidContext);
        return { ...props, uuid };
      },
      model: createPageModel,
      view(props: { model: { opened: () => void; openedWith: string } }) {
        return createElement(
          "button",
          { onClick: () => props.model.opened() },
          props.model.openedWith || "idle",
        );
      },
    });

    renderWithScope(
      appScope,
      createElement(UuidContext.Provider, { value: "ctx-9" }, createElement(Page, { label: "p" })),
    );

    await act(async () => {
      button().click();
    });

    expect(button().textContent).toBe("p:ctx-9");
  });

  it("without mapProps, external and model props coincide", () => {
    const appScope = scope();
    let seen = "";

    function createModel({ props }: ModelContext<{ label: string }>) {
      const ping = event<void>();
      reaction({ on: ping, run: () => (seen = props.label) });
      return { ping };
    }

    const C = component({
      model: createModel,
      view(props: { model: { ping: () => void } }) {
        return createElement("button", { onClick: () => props.model.ping() }, "go");
      },
    });

    renderWithScope(appScope, createElement(C, { label: "plain" }));
    act(() => {
      button().click();
    });
    expect(seen).toBe("plain");
  });
});
