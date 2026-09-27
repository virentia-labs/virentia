// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { act, createElement, useEffect } from "react";
import { render } from "@testing-library/react";
import { reactive, scope, scoped, store } from "@virentia/core";
import { ScopeProvider, useModel, useProvidedScope, useUnit } from "../../lib";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe("ScopeProvider hydration state", () => {
  it("caches hydration snapshots for reactive objects and arrays", async () => {
    const user = reactive({ name: "Ada" });
    const list = reactive([1, 2]);
    const frozen = scope();
    const client = scope();
    scoped(client, () => {
      user.name = "Grace";
      list[1] = 9;
    });
    function View() {
      const object = useUnit(user);
      const array = useUnit(list);
      return createElement("span", null, `${object.name}:${array.join(",")}`);
    }
    const container = document.createElement("div");
    container.innerHTML = "<span>Ada:1,2</span>";
    document.body.append(container);
    const span = container.firstChild;
    const error = vi.spyOn(console, "error");
    let root!: ReturnType<typeof render>;
    try {
      await act(async () => {
        root = render(
          createElement(
            ScopeProvider,
            { scope: client, hydrationScope: frozen },
            createElement(View),
          ),
          { container, hydrate: true },
        );
      });
      expect(container.firstChild).toBe(span);
      expect(span?.textContent).toBe("Grace:1,9");
      expect(error).not.toHaveBeenCalled();
    } finally {
      if (root) await act(async () => root.unmount());
      error.mockRestore();
      container.remove();
    }
  });

  it("hydrates scalar, shape and legacy model reads while actions retain the live scope", async () => {
    const count = store(3);
    const model = { count };
    const seenScopes: object[] = [];
    function Counter() {
      const value = useUnit(count);
      const shape = useUnit(model);
      const legacy = useModel(model);
      const live = useProvidedScope();
      useEffect(() => {
        seenScopes.push(live);
      }, []);
      return createElement(
        "button",
        {
          onClick: () =>
            scoped(live, () => {
              count.value++;
            }),
        },
        `${value}:${shape.count}:${legacy.count}`,
      );
    }
    const client = scope({ values: [[count, 4]] });
    const frozen = scope({ values: [[count, 3]] });
    const container = document.createElement("div");
    container.innerHTML = "<button>3:3:3</button>";
    document.body.append(container);
    const button = container.querySelector("button")!;
    let root!: ReturnType<typeof render>;
    try {
      await act(async () => {
        root = render(
          createElement(
            ScopeProvider,
            { scope: client, hydrationScope: frozen },
            createElement(Counter),
          ),
          { container, hydrate: true },
        );
      });
      expect(container.querySelector("button")).toBe(button);
      expect(button.textContent).toBe("4:4:4");
      expect(seenScopes).toEqual([client]);
      await act(async () => button.click());
      expect(button.textContent).toBe("5:5:5");
      expect(scoped(frozen, () => count.value)).toBe(3);
    } finally {
      if (root) await act(async () => root.unmount());
      container.remove();
    }
  });
});
