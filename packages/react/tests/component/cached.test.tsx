// @vitest-environment happy-dom

import { event, reaction, scope, scoped, store } from "@virentia/core";
import { fireEvent } from "@testing-library/react";
import { act, createElement } from "react";
import { describe, expect, it } from "vitest";
import { component, createModelCache, ScopeProvider } from "../../lib";
import { resetAmbientScopeAfterEach } from "../support/ambient-scope-reset";
import { button, renderWithScope, withScope } from "../support/render-harness";

resetAmbientScopeAfterEach();

describe("component (cached)", () => {
  it("reuses a cached instance across unmount without disposing it", async () => {
    const appScope = scope();
    let created = 0;
    function createModel() {
      created += 1;
      const clicked = event<void>();
      const count = store(0);
      reaction({ on: clicked, run: () => (count.value += 1) });
      return { clicked, count };
    }
    const cache = createModelCache<string, { id: string }, ReturnType<typeof createModel>>();
    const C = component({
      cache,
      key: (props: { id: string }) => props.id,
      model: createModel,
      view({ model }: any) {
        return createElement("button", { onClick: () => model.clicked() }, String(model.count));
      },
    });

    const view = renderWithScope(appScope, createElement(C, { id: "a" }));
    await act(async () => {
      fireEvent.click(button());
    });
    expect(button().textContent).toBe("1");

    view.rerender(withScope(appScope, null));
    expect(cache.has("a", appScope)).toBe(true); // not disposed on unmount

    view.rerender(withScope(appScope, createElement(C, { id: "a" })));
    expect(button().textContent).toBe("1"); // state preserved
    expect(created).toBe(1);
    cache.clear();
  });

  it("creates a fresh instance on key change while leaving the old key cached", async () => {
    const appScope = scope();
    function createModel() {
      const clicked = event<void>();
      const count = store(0);
      reaction({ on: clicked, run: () => (count.value += 1) });
      return { clicked, count };
    }
    const cache = createModelCache<string, { id: string }, ReturnType<typeof createModel>>();
    const C = component({
      cache,
      key: (props: { id: string }) => props.id,
      model: createModel,
      view({ model }: any) {
        return createElement("button", { onClick: () => model.clicked() }, String(model.count));
      },
    });

    const view = renderWithScope(appScope, createElement(C, { id: "a" }));
    await act(async () => {
      fireEvent.click(button());
    });
    expect(button().textContent).toBe("1");

    view.rerender(withScope(appScope, createElement(C, { id: "b" })));
    expect(button().textContent).toBe("0"); // fresh instance for b
    expect(cache.has("a", appScope)).toBe(true); // a preserved
    expect(cache.get("a", appScope)).toBeDefined();
    scoped(appScope, () => expect(cache.get("a", appScope)!.count.value).toBe(1));
    cache.clear();
  });

  // TODO(phase-2 dedup): overlaps "reuses a cached instance across unmount without disposing it"
  it("keeps cached models alive across unmounts until the cache deletes them", async () => {
    const appScope = scope();
    let created = 0;

    function createCachedModel() {
      created += 1;
      const clicked = event<void>();
      const count = store(0);

      reaction({
        on: clicked,
        run() {
          count.value += 1;
        },
      });

      return { clicked, count };
    }

    const cache = createModelCache<string, { id: string }, ReturnType<typeof createCachedModel>>();
    const CachedCounter = component({
      cache,
      key: (props: { id: string }) => props.id,
      model: createCachedModel,
      view({ model }) {
        return createElement("button", { onClick: () => model.clicked() }, model.count);
      },
    });

    const view = renderWithScope(appScope, createElement(CachedCounter, { id: "chat:1" }));

    await act(async () => {
      fireEvent.click(button());
    });

    expect(button().textContent).toBe("1");

    view.rerender(createElement(ScopeProvider, { scope: appScope }, null));

    expect(cache.has("chat:1", appScope)).toBe(true);

    view.rerender(
      createElement(
        ScopeProvider,
        { scope: appScope },
        createElement(CachedCounter, { id: "chat:1" }),
      ),
    );

    expect(button().textContent).toBe("1");
    expect(created).toBe(1);

    view.rerender(createElement(ScopeProvider, { scope: appScope }, null));
    cache.delete("chat:1", appScope);
    view.rerender(
      createElement(
        ScopeProvider,
        { scope: appScope },
        createElement(CachedCounter, { id: "chat:1" }),
      ),
    );

    expect(created).toBe(2);
    expect(button().textContent).toBe("0");
  });
});
